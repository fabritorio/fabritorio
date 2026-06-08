import type {
    ChannelNode,
    DispatchEvent,
    Edge,
    Graph,
    Node,
    ObservabilityEvent,
    ToolCall,
} from '@fabritorio/types';

export function isSystemChannel(node: Node): node is ChannelNode {
    return (
        node.type === 'channel' &&
        typeof node.owner_node_id === 'string' &&
        node.owner_node_id.length > 0
    );
}

export function isUserChannel(node: Node): node is ChannelNode {
    return node.type === 'channel' && !isSystemChannel(node);
}

export function sidecarChannelIdFor(graph: Graph, agentId: string): string | null {
    const sidecar = graph.nodes.find(
        (n): n is ChannelNode => n.type === 'channel' && n.owner_node_id === agentId,
    );
    return sidecar?.id ?? null;
}

export function chatSource(agentId: string, convId: string): string {
    return `chat:${agentId}:${convId}`;
}

export function isUserRootEcho(ev: DispatchEvent): boolean {
    return ev.parentId == null && ev.messages?.[0]?.role === 'user';
}

export function hideSystemChannels(
    nodes: ReadonlyArray<Node>,
    edges: ReadonlyArray<Edge>,
): { nodes: Node[]; edges: Edge[] } {
    const systemIds = new Set<string>();
    for (const n of nodes) {
        if (isSystemChannel(n)) systemIds.add(n.id);
    }
    return {
        nodes: nodes.filter((n) => !systemIds.has(n.id)),
        edges: edges.filter(
            (e) => !systemIds.has(e.source.node_id) && !systemIds.has(e.target.node_id),
        ),
    };
}

export interface AgentConversationSummary {
    convId: string;
    source: string;
    rootEventId: string;
    bytes: number;
    label?: string;
}

export interface ToolInvocation {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    result?: {
        stdout: string;
        stderr: string;
        exit_code: number;
    };
}

export interface UserTurn {
    kind: 'user';
    rootEventId: string;
    ts: number;
    content: string;
}

export interface AssistantTurn {
    kind: 'assistant';
    rootEventId: string;
    ts: number;
    content: string;
    reasoning?: string;
    toolCalls: ToolInvocation[];
    errored: boolean;
    stopped: boolean;
    rootSource?: string;
}

export type ChatTurn = UserTurn | AssistantTurn;

interface ReplayLike {
    events: ReadonlyArray<DispatchEvent | ObservabilityEvent>;
}

export function buildChatTurns(
    replay: ReplayLike,
    channelSource: string,
    liveReplies: ReadonlyArray<DispatchEvent> = [],
    stoppedEventIds: ReadonlySet<string> = new Set(),
): ChatTurn[] {
    const turns: ChatTurn[] = [];
    const userByRoot = new Map<string, UserTurn>();
    const assistantByRoot = new Map<string, AssistantTurn>();
    const toolCallsByRoot = new Map<string, Map<string, ToolInvocation>>();
    const rootSourceById = new Map<string, string>();
    for (const ev of replay.events) {
        if (!isDispatchEvent(ev)) continue;
        if (!ev.parentId) {
            rootSourceById.set(ev.eventId, ev.source);
        } else if (!rootSourceById.has(ev.parentId)) {
            rootSourceById.set(ev.parentId, ev.source);
        }
    }
    for (const reply of liveReplies) {
        if (reply.parentId && !rootSourceById.has(reply.parentId)) {
            rootSourceById.set(reply.parentId, reply.source);
        }
    }

    function rootInScope(root: string): boolean {
        const src = rootSourceById.get(root);
        return src === undefined || src === channelSource;
    }

    function ensureUser(root: string, ts: number, content: string): UserTurn {
        let turn = userByRoot.get(root);
        if (!turn) {
            turn = { kind: 'user', rootEventId: root, ts, content };
            userByRoot.set(root, turn);
            turns.push(turn);
        }
        return turn;
    }

    function ensureAssistant(root: string, ts: number): AssistantTurn {
        let turn = assistantByRoot.get(root);
        if (!turn) {
            turn = {
                kind: 'assistant',
                rootEventId: root,
                ts,
                content: '',
                toolCalls: [],
                errored: false,
                stopped: stoppedEventIds.has(root),
            };
            const rootSource = rootSourceById.get(root);
            if (rootSource !== undefined) {
                turn.rootSource = rootSource;
            }
            assistantByRoot.set(root, turn);
            turns.push(turn);
        }
        return turn;
    }

    function toolMap(root: string): Map<string, ToolInvocation> {
        let m = toolCallsByRoot.get(root);
        if (!m) {
            m = new Map();
            toolCallsByRoot.set(root, m);
        }
        return m;
    }

    for (const ev of replay.events) {
        if (isDispatchEvent(ev)) {
            if (!ev.parentId && ev.source === channelSource) {
                const userMsg = ev.messages.find((m) => m.role === 'user');
                ensureUser(ev.eventId, ev.timestamp, userMsg?.content ?? '');
            } else if (ev.parentId && ev.source === channelSource) {
                if (readStoppedMeta(ev.meta)) {
                    ensureAssistant(ev.parentId, ev.timestamp).stopped = true;
                }
            }
            continue;
        }

        const ts = Date.parse(ev.ts);
        const root = ev.eventId;

        if (!rootInScope(root)) continue;

        if (ev.type === 'tool.called') {
            const calls = toolMap(root);
            calls.set(ev.call_id, {
                callId: ev.call_id,
                name: ev.tool_name,
                args: ev.args,
            });
            const turn = ensureAssistant(root, ts);
            turn.toolCalls = [...calls.values()];
            continue;
        }

        if (ev.type === 'tool.result') {
            const calls = toolMap(root);
            const existing = calls.get(ev.call_id);
            const updated: ToolInvocation = {
                ...(existing ?? { callId: ev.call_id, name: '', args: {} }),
                result: {
                    stdout: ev.stdout,
                    stderr: ev.stderr,
                    exit_code: ev.exit_code,
                },
            };
            calls.set(ev.call_id, updated);
            const turn = ensureAssistant(root, ts);
            turn.toolCalls = [...calls.values()];
            continue;
        }

        if (ev.type === 'llm.response') {
            if (ev.reasoning && ev.reasoning.length > 0) {
                const turn = ensureAssistant(root, ts);
                turn.reasoning = ev.reasoning;
            }
            continue;
        }

        if (ev.type === 'output.emitted') {
            const turn = ensureAssistant(root, ts);
            turn.ts = ts;
            const assistantMsg = ev.messages.find((m) => m.role === 'assistant');
            if (assistantMsg) {
                turn.content = assistantMsg.content;
                if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
                    mergeAssistantToolCalls(turn, toolMap(root), assistantMsg.tool_calls);
                }
            }
            if (ev.port === 'error') turn.errored = true;
            continue;
        }
    }

    for (const reply of liveReplies) {
        if (!reply.parentId) continue;
        if (reply.source !== channelSource) continue;
        const root = reply.parentId;
        const turn = ensureAssistant(root, reply.timestamp);
        if (turn.content.length === 0) {
            const assistantMsg = reply.messages.find((m) => m.role === 'assistant');
            if (assistantMsg) {
                turn.content = assistantMsg.content;
            }
        }
        if (reply.meta && (reply.meta as { port?: string }).port === 'error') {
            turn.errored = true;
        }
        if (readStoppedMeta(reply.meta)) {
            turn.stopped = true;
        }
    }

    turns.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        if (a.rootEventId === b.rootEventId) {
            return a.kind === 'user' ? -1 : 1;
        }
        return 0;
    });
    return turns;
}

function mergeAssistantToolCalls(
    turn: AssistantTurn,
    calls: Map<string, ToolInvocation>,
    toolCalls: ToolCall[],
): void {
    for (const tc of toolCalls) {
        if (!calls.has(tc.id)) {
            calls.set(tc.id, { callId: tc.id, name: tc.name, args: tc.arguments });
        }
    }
    turn.toolCalls = [...calls.values()];
}

function readStoppedMeta(meta: Record<string, unknown> | undefined): boolean {
    return meta !== undefined && (meta as { stopped?: unknown }).stopped === true;
}

function isDispatchEvent(event: DispatchEvent | ObservabilityEvent): event is DispatchEvent {
    return !('type' in event) && typeof (event as DispatchEvent).timestamp === 'number';
}
