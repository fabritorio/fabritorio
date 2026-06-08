import type {
    CliAgentNode,
    DispatchEvent,
    Edge,
    Graph,
    Message,
    MemoryNode,
    Node,
    NodeType,
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

const CLI_REFERENCE_SOURCES: ReadonlySet<NodeType> = new Set<NodeType>([
    'memory',
    'skill',
    'skill_pack',
    'workspace',
]);
const isReferenceEdge = makeIsReferenceEdge(CLI_REFERENCE_SOURCES);

export interface CliAgentBindingDeps {
    memoryRegistry: MemoryRegistry;
    skillRegistry: SkillRegistry;
    graphStore: GraphStore;
    executor?: CliExecutor;
}

interface CliAgentConfig {
    command: string;
    cwd: string | undefined;
    sessionMode: 'stateless' | 'session-aware';
    outputFormat: 'text' | 'jsonl';
    skillContext: string;
    contextMemoryBlock: string;
    memoryHandleFor: () => MemoryHandle | undefined;
    executor: CliExecutor;
}

class CliAgent implements Agent {
    public readonly outputNodeId: string;
    private readonly cfg: CliAgentConfig;

    constructor(nodeId: string, cfg: CliAgentConfig) {
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
        const includeSkills = cfg.sessionMode !== 'session-aware' || priorSessionId === null;
        const skillBlock = includeSkills && cfg.skillContext.length > 0 ? cfg.skillContext : '';
        const prefixParts: string[] = [];
        if (cfg.contextMemoryBlock.length > 0) prefixParts.push(cfg.contextMemoryBlock);
        if (skillBlock.length > 0) prefixParts.push(skillBlock);
        const query =
            prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n${userText}` : userText;

        const argv = buildArgv(cfg.sessionMode, priorSessionId, query);

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
            result = { stdout: '', stderr: execError, exit_code: 1, timed_out: false };
        }

        const errored = execError !== null || result.exit_code !== 0;
        let replyContent: string;
        if (errored) {
            replyContent = `[error] ${
                execError ?? result.stderr.trim() ?? `exit ${result.exit_code}`
            }`;
        } else {
            const parsed = parseStdout(result.stdout, cfg.outputFormat);
            replyContent = parsed.reply;
            if (memoryHandle) {
                const newSessionId = parsed.sessionId ?? priorSessionId;
                if (newSessionId) {
                    memoryHandle.write(sessionKey, newSessionId);
                }
            }
        }

        return {
            output: { role: 'assistant', content: replyContent },
            errored,
        };
    }
}

export function createCliAgentBinding(deps: CliAgentBindingDeps): NodeBinding {
    const executor = deps.executor ?? defaultCliExecutor;
    return createAgentBinding({
        nodeType: 'cli_agent',
        isReferenceEdge,
        async build(ctx) {
            const node = ctx.node as CliAgentNode;

            const wired = nodesAdjacentTo(ctx.graph, node.id);
            for (const w of wired) {
                if (REJECTED_ATTACHMENT_TYPES.includes(w.type)) {
                    throw new Error(
                        `cli_agent ${node.id}: ${w.type} attachments are forbidden — the wrapped CLI owns its own model/handler`,
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
            const seenSkillNames = new Set<string>();
            const collectedSkills: SkillNode[] = [];
            const addSkillNode = (sn: SkillNode) => {
                if (seenSkillNames.has(sn.name)) return;
                seenSkillNames.add(sn.name);
                collectedSkills.push(sn);
            };
            for (const name of innerCfg.skillNames) {
                addSkillNode({
                    id: `__inner-skill-${name}`,
                    type: 'skill',
                    position: { x: 0, y: 0 },
                    name,
                });
            }
            for (const sn of skillNodes) addSkillNode(sn);
            for (const pn of skillPackNodes) {
                if (!pn.ref_id) continue;
                const l0 = await deps.graphStore.get(pn.ref_id);
                if (!l0) {
                    throw new Error(
                        `cli_agent ${node.id}: skill_pack ${pn.id} references missing L0 graph ${pn.ref_id}`,
                    );
                }
                if (l0.kind !== 'skillpack') {
                    throw new Error(
                        `cli_agent ${node.id}: skill_pack ${pn.id} references graph ${pn.ref_id} of kind ${l0.kind} (expected skillpack)`,
                    );
                }
                for (const inner of l0.nodes) {
                    if (inner.type === 'skill') addSkillNode(inner);
                }
            }

            const cwd = expandHomePath(innerCfg.cwd ?? workspaceNode?.path ?? node.cwd);
            const skillContext = buildSkillContext(collectedSkills, deps.skillRegistry);
            const memoryHandleFor = historyMemory
                ? (() => {
                      const handle = deps.memoryRegistry.resolve(historyMemory);
                      return () => handle;
                  })()
                : () => undefined;

            return new CliAgent(node.id, {
                command: node.command,
                cwd,
                sessionMode: node.session_mode,
                outputFormat: node.output_format ?? 'text',
                skillContext,
                contextMemoryBlock,
                memoryHandleFor,
                executor,
            });
        },
        async dependencies(ctx) {
            if (ctx.node.type !== 'cli_agent') return [];
            const node = ctx.node as CliAgentNode;
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

function buildArgv(
    sessionMode: 'stateless' | 'session-aware',
    sessionId: string | null,
    query: string,
): string[] {
    if (sessionMode !== 'session-aware') return [query];
    if (sessionId) return ['continue', sessionId, query];
    return ['new', query];
}

function parseStdout(
    stdout: string,
    format: 'text' | 'jsonl',
): { sessionId: string | null; reply: string } {
    if (format === 'jsonl') {
        let sessionId: string | null = null;
        const parts: string[] = [];
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                if (typeof parsed.session_id === 'string') sessionId = parsed.session_id;
                if (typeof parsed.content === 'string') parts.push(parsed.content);
            } catch {
                parts.push(trimmed);
            }
        }
        return { sessionId, reply: parts.join('\n').trim() };
    }
    const newlineIdx = stdout.indexOf('\n');
    const firstLine = newlineIdx === -1 ? stdout : stdout.slice(0, newlineIdx);
    const headerMatch = /^session:\s*([A-Za-z0-9_-]+)\s*$/.exec(firstLine);
    if (headerMatch) {
        return {
            sessionId: headerMatch[1] ?? null,
            reply: stdout.slice(newlineIdx + 1).trim(),
        };
    }
    return { sessionId: null, reply: stdout.trim() };
}

function buildSkillContext(skillNodes: SkillNode[], registry: SkillRegistry): string {
    if (skillNodes.length === 0) return '';
    const blocks: string[] = [];
    for (const sn of skillNodes) {
        const loaded = registry.get(sn.name);
        const description = loaded?.description ?? '';
        const body = loaded?.body ?? '';
        const header = `[Skill: ${sn.name}${description ? ` — ${description}` : ''}]`;
        blocks.push(body ? `${header}\n${body}` : header);
    }
    return blocks.join('\n\n');
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
