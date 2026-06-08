import type {
    DispatchEvent,
    Edge,
    GoClaudeAgentNode,
    Graph,
    Message,
    MemoryNode,
    Node,
    NodeType,
    WorkspaceNode,
} from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';
import type { NodeBinding } from '../graph-runtime.js';
import type { MemoryHandle, MemoryRegistry } from '../memory.js';
import { partitionMemoryNodes, renderInjectedMemoryBlock } from '../memory.js';
import { defaultCliExecutor, type CliExecutor } from '../cli-executor.js';
import type { Agent, AgentDispatchCtx, AgentReply } from '../agents/agent.js';
import { createAgentBinding } from '../agents/binding.js';
import { cliInvocationDependencies, readCliInvocation } from '../agents/cli-invocation.js';
import { expandHomePath } from '../agents/wiring.js';

const REJECTED_ATTACHMENT_TYPES: NodeType[] = ['tool', 'model', 'handler', 'tool_pack'];

const SESSION_LINE_RE = /^\[session:\s*(.+?)\]\s*$/m;

export interface GoClaudeAgentBindingDeps {
    memoryRegistry: MemoryRegistry;
    graphStore: GraphStore;
    executor?: CliExecutor;
}

interface GoClaudeAgentConfig {
    command: string;
    cwd: string | undefined;
    sessionMode: 'stateless' | 'session-aware';
    sessionName: string | undefined;
    contextMemoryBlock: string;
    memoryHandleFor: () => MemoryHandle | undefined;
    executor: CliExecutor;
}

class GoClaudeAgent implements Agent {
    public readonly outputNodeId: string;
    private readonly cfg: GoClaudeAgentConfig;

    constructor(nodeId: string, cfg: GoClaudeAgentConfig) {
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
        const argv = buildGoClaudeArgv({
            sessionMode: cfg.sessionMode,
            priorSessionId,
            sessionName: cfg.sessionName,
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

        const errored = execError !== null || result.exit_code !== 0;
        if (errored) {
            const detail = execError ?? result.stderr.trim() ?? `exit ${result.exit_code}`;
            return {
                output: { role: 'assistant', content: `[error] ${detail}` },
                errored: true,
            };
        }

        if (memoryHandle) {
            const newSessionId = parseSessionFromStderr(result.stderr);
            const finalSessionId = newSessionId ?? priorSessionId;
            if (finalSessionId) {
                memoryHandle.write(sessionKey, finalSessionId);
            }
        }

        return {
            output: { role: 'assistant', content: result.stdout.trim() },
            errored: false,
        };
    }
}

export function createGoClaudeAgentBinding(deps: GoClaudeAgentBindingDeps): NodeBinding {
    const executor = deps.executor ?? defaultCliExecutor;
    return createAgentBinding({
        nodeType: 'go_claude_agent',
        isReferenceEdge,
        async build(ctx) {
            const node = ctx.node as GoClaudeAgentNode;

            const wired = nodesAdjacentTo(ctx.graph, node.id);
            for (const w of wired) {
                if (REJECTED_ATTACHMENT_TYPES.includes(w.type)) {
                    throw new Error(
                        `go_claude_agent ${node.id}: ${w.type} attachments are forbidden — go-claude owns its own model/handler/tools`,
                    );
                }
            }

            const memoryNodes = wired.filter((n): n is MemoryNode => n.type === 'memory');
            const { historyMemory, injectedMemories } = partitionMemoryNodes(memoryNodes);
            const contextMemoryBlock = renderInjectedMemoryBlock(injectedMemories, (n) =>
                deps.memoryRegistry.resolve(n),
            );
            const workspaceNode = wired.find((n): n is WorkspaceNode => n.type === 'workspace');

            const innerCfg = await readCliInvocation(
                { graphStore: deps.graphStore },
                node.ref_id,
                node.id,
            );
            const cwd = expandHomePath(innerCfg.cwd ?? workspaceNode?.path ?? node.cwd);
            const memoryHandleFor = historyMemory
                ? (() => {
                      const handle = deps.memoryRegistry.resolve(historyMemory);
                      return () => handle;
                  })()
                : () => undefined;

            return new GoClaudeAgent(node.id, {
                command: node.command ?? 'go-claude',
                cwd,
                sessionMode: node.session_mode,
                sessionName: node.session_name,
                contextMemoryBlock,
                memoryHandleFor,
                executor,
            });
        },
        async dependencies(ctx) {
            if (ctx.node.type !== 'go_claude_agent') return [];
            const node = ctx.node as GoClaudeAgentNode;
            return cliInvocationDependencies({ graphStore: deps.graphStore }, node.ref_id);
        },
    });
}

interface ArgvArgs {
    sessionMode: 'stateless' | 'session-aware';
    priorSessionId: string | null;
    sessionName: string | undefined;
    query: string;
}

function buildGoClaudeArgv(args: ArgvArgs): string[] {
    if (args.sessionMode !== 'session-aware') return [args.query];
    if (args.priorSessionId) return ['continue', args.priorSessionId, args.query];
    if (args.sessionName) return ['new', '--name', args.sessionName, args.query];
    return ['new', args.query];
}

function parseSessionFromStderr(stderr: string): string | null {
    const match = SESSION_LINE_RE.exec(stderr);
    return match ? (match[1]?.trim() ?? null) : null;
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

function isReferenceEdge(graph: Graph, edge: Edge): boolean {
    const src = graph.nodes.find((n) => n.id === edge.source.node_id);
    if (!src) return false;
    return (
        src.type === 'memory' ||
        src.type === 'skill' ||
        src.type === 'skill_pack' ||
        src.type === 'workspace'
    );
}
