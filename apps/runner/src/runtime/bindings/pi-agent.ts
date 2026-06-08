import type {
    DispatchEvent,
    Edge,
    Graph,
    Message,
    MemoryNode,
    Node,
    NodeType,
    PiAgentNode,
    SkillNode,
    SkillPackNode,
    WorkspaceNode,
} from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';
import type { NodeBinding } from '../graph-runtime.js';
import type { MemoryHandle, MemoryRegistry } from '../memory.js';
import { partitionMemoryNodes, renderInjectedMemoryBlock } from '../memory.js';
import type { SkillRegistry } from '../skills.js';
import { defaultCliExecutor, type CliExecutor } from '../cli-executor.js';
import type { Agent, AgentDispatchCtx, AgentReply } from '../agents/agent.js';
import { createAgentBinding } from '../agents/binding.js';
import { cliInvocationDependencies, readCliInvocation } from '../agents/cli-invocation.js';
import { expandHomePath, makeIsReferenceEdge } from '../agents/wiring.js';

const REJECTED_ATTACHMENT_TYPES: NodeType[] = ['tool', 'model', 'handler', 'tool_pack'];

const PI_REFERENCE_SOURCES: ReadonlySet<NodeType> = new Set<NodeType>([
    'memory',
    'skill',
    'skill_pack',
    'workspace',
]);
const isReferenceEdge = makeIsReferenceEdge(PI_REFERENCE_SOURCES);

export interface PiAgentBindingDeps {
    memoryRegistry: MemoryRegistry;
    skillRegistry: SkillRegistry;
    graphStore: GraphStore;
    executor?: CliExecutor;
}

interface PiAgentConfig {
    command: string;
    cwd: string | undefined;
    sessionMode: 'stateless' | 'session-aware';
    provider: string | undefined;
    model: string | undefined;
    skillPaths: string[];
    memoryHandleFor: () => MemoryHandle | undefined;
    contextMemoryBlock: string;
    executor: CliExecutor;
}

class PiAgent implements Agent {
    public readonly outputNodeId: string;
    private readonly cfg: PiAgentConfig;

    constructor(nodeId: string, cfg: PiAgentConfig) {
        this.outputNodeId = nodeId;
        this.cfg = cfg;
    }

    async dispatch(inbound: DispatchEvent, _ctx: AgentDispatchCtx): Promise<AgentReply> {
        const cfg = this.cfg;
        const memoryHandle =
            cfg.sessionMode === 'session-aware' ? cfg.memoryHandleFor() : undefined;
        const sessionKey = inbound.source;
        const priorSessionId = memoryHandle ? readSessionId(memoryHandle.read(sessionKey)) : null;

        const userText = lastUserText(inbound.messages);
        const query =
            cfg.contextMemoryBlock.length > 0
                ? `${cfg.contextMemoryBlock}\n\n${userText}`
                : userText;
        const argv = buildPiArgv({
            sessionMode: cfg.sessionMode,
            priorSessionId,
            provider: cfg.provider,
            model: cfg.model,
            skillPaths: cfg.skillPaths,
            query,
        });

        let result;
        let execError: string | null = null;
        try {
            result = await cfg.executor({
                command: cfg.command,
                argv,
                ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
            });
        } catch (err) {
            execError = err instanceof Error ? err.message : String(err);
            result = {
                stdout: '',
                stderr: execError,
                exit_code: 1,
                timed_out: false,
            };
        }

        if (execError !== null || result.exit_code !== 0) {
            const detail = execError ?? result.stderr.trim() ?? `exit ${result.exit_code}`;
            return {
                output: { role: 'assistant', content: `[error] ${detail}` },
                errored: true,
            };
        }

        const parsed = parsePiJsonStream(result.stdout);
        if (!parsed.ok) {
            const detail = parsed.errorMessage ?? 'no agent_end event';
            return {
                output: { role: 'assistant', content: `[error] ${detail}` },
                errored: true,
            };
        }

        if (memoryHandle) {
            const finalSessionId = parsed.sessionId ?? priorSessionId;
            if (finalSessionId) {
                memoryHandle.write(sessionKey, finalSessionId);
            }
        }

        return {
            output: { role: 'assistant', content: parsed.replyText },
            errored: false,
        };
    }
}

export function createPiAgentBinding(deps: PiAgentBindingDeps): NodeBinding {
    const executor = deps.executor ?? defaultCliExecutor;
    return createAgentBinding({
        nodeType: 'pi_agent',
        isReferenceEdge,
        async build(ctx) {
            const node = ctx.node as PiAgentNode;

            const wired = nodesAdjacentTo(ctx.graph, node.id);
            for (const w of wired) {
                if (REJECTED_ATTACHMENT_TYPES.includes(w.type)) {
                    throw new Error(
                        `pi_agent ${node.id}: ${w.type} attachments are forbidden — pi owns its own model/handler/tools`,
                    );
                }
            }

            const memoryNodes = wired.filter((n): n is MemoryNode => n.type === 'memory');
            const { historyMemory, injectedMemories } = partitionMemoryNodes(memoryNodes);
            const contextMemoryBlock = renderInjectedMemoryBlock(injectedMemories, (n) =>
                deps.memoryRegistry.resolve(n),
            );
            const workspaceNode = wired.find((n): n is WorkspaceNode => n.type === 'workspace');
            const skillNodes = wired.filter((n): n is SkillNode => n.type === 'skill');
            const skillPackNodes = wired.filter((n): n is SkillPackNode => n.type === 'skill_pack');

            const innerCfg = await readCliInvocation(
                { graphStore: deps.graphStore },
                node.ref_id,
                node.id,
            );
            const seenSkillNames = new Set<string>(innerCfg.skillNames);
            const skillPaths: string[] = [];
            for (const name of innerCfg.skillNames) {
                const loaded = deps.skillRegistry.get(name);
                if (loaded?.path) skillPaths.push(loaded.path);
            }
            const addLegacySkill = (sn: SkillNode) => {
                if (seenSkillNames.has(sn.name)) return;
                seenSkillNames.add(sn.name);
                const loaded = deps.skillRegistry.get(sn.name);
                if (loaded?.path) skillPaths.push(loaded.path);
            };
            for (const sn of skillNodes) addLegacySkill(sn);
            for (const pn of skillPackNodes) {
                if (!pn.ref_id) continue;
                const l0 = await deps.graphStore.get(pn.ref_id);
                if (!l0) {
                    throw new Error(
                        `pi_agent ${node.id}: skill_pack ${pn.id} references missing L0 graph ${pn.ref_id}`,
                    );
                }
                if (l0.kind !== 'skillpack') {
                    throw new Error(
                        `pi_agent ${node.id}: skill_pack ${pn.id} references graph ${pn.ref_id} of kind ${l0.kind} (expected skillpack)`,
                    );
                }
                for (const inner of l0.nodes) {
                    if (inner.type === 'skill') addLegacySkill(inner);
                }
            }

            const provider = innerCfg.provider ?? node.provider;
            const model = innerCfg.model ?? node.model;
            const cwd = expandHomePath(innerCfg.cwd ?? workspaceNode?.path ?? node.cwd);
            const memoryHandleFor = historyMemory
                ? (() => {
                      const handle = deps.memoryRegistry.resolve(historyMemory);
                      return () => handle;
                  })()
                : () => undefined;

            return new PiAgent(node.id, {
                command: node.command ?? 'pi',
                cwd,
                sessionMode: node.session_mode,
                provider,
                model,
                skillPaths,
                memoryHandleFor,
                contextMemoryBlock,
                executor,
            });
        },
        async dependencies(ctx) {
            if (ctx.node.type !== 'pi_agent') return [];
            const node = ctx.node as PiAgentNode;
            const wired = nodesAdjacentTo(ctx.graph, node.id);
            const ids: string[] = [];
            for (const w of wired) {
                if (w.type === 'skill_pack') {
                    const refId = (w as SkillPackNode).ref_id;
                    if (typeof refId === 'string' && refId.length > 0) ids.push(refId);
                }
            }
            const innerIds = await cliInvocationDependencies(
                { graphStore: deps.graphStore },
                node.ref_id,
            );
            ids.push(...innerIds);
            return ids;
        },
    });
}

interface ArgvArgs {
    sessionMode: 'stateless' | 'session-aware';
    priorSessionId: string | null;
    provider: string | undefined;
    model: string | undefined;
    skillPaths: string[];
    query: string;
}

function buildPiArgv(args: ArgvArgs): string[] {
    const argv: string[] = ['--mode', 'json'];
    if (args.sessionMode !== 'session-aware') {
        argv.push('--no-session');
    } else if (args.priorSessionId) {
        argv.push('--session', args.priorSessionId);
    }
    if (args.provider) argv.push('--provider', args.provider);
    if (args.model) argv.push('--model', args.model);
    for (const path of args.skillPaths) {
        argv.push('--skill', path);
    }
    argv.push(args.query);
    return argv;
}

interface ParsedPiStream {
    ok: boolean;
    sessionId: string | null;
    replyText: string;
    errorMessage?: string;
}

function parsePiJsonStream(stdout: string): ParsedPiStream {
    let sessionId: string | null = null;
    let agentEndSeen = false;
    let replyText = '';
    let errorMessage: string | undefined;
    let stopReason: string | undefined;

    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            continue;
        }
        const type = typeof event.type === 'string' ? event.type : '';
        if (type === 'session' && typeof event.id === 'string') {
            sessionId = event.id;
        } else if (type === 'agent_end' && Array.isArray(event.messages)) {
            agentEndSeen = true;
            const finalAssistant = lastAssistantMessage(event.messages);
            if (finalAssistant) {
                replyText = extractAssistantText(finalAssistant);
                const sr = (finalAssistant as { stopReason?: unknown }).stopReason;
                if (typeof sr === 'string') stopReason = sr;
                const em = (finalAssistant as { errorMessage?: unknown }).errorMessage;
                if (typeof em === 'string') errorMessage = em;
            }
        }
    }

    if (!agentEndSeen) {
        return { ok: false, sessionId, replyText: '', errorMessage: 'no agent_end event' };
    }
    if (stopReason === 'error' || stopReason === 'aborted') {
        return {
            ok: false,
            sessionId,
            replyText: '',
            errorMessage: errorMessage ?? `pi stopped with reason "${stopReason}"`,
        };
    }
    return { ok: true, sessionId, replyText };
}

function lastAssistantMessage(messages: unknown[]): Record<string, unknown> | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m !== null && typeof m === 'object' && (m as { role?: unknown }).role === 'assistant') {
            return m as Record<string, unknown>;
        }
    }
    return null;
}

function extractAssistantText(message: Record<string, unknown>): string {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
        if (
            block !== null &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
        ) {
            parts.push((block as { text: string }).text);
        }
    }
    return parts.join('');
}

function lastUserText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user') return m.content;
    }
    return '';
}

function readSessionId(raw: unknown): string | null {
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function nodesAdjacentTo(graph: Graph, targetId: string): Node[] {
    const ids = new Set<string>();
    for (const e of graph.edges as Edge[]) {
        if (e.target.node_id === targetId) ids.add(e.source.node_id);
        if (e.source.node_id === targetId) ids.add(e.target.node_id);
    }
    return graph.nodes.filter((n) => ids.has(n.id)) as Node[];
}
