import type {
    AskCallDetail,
    AskCallSummary,
    DispatchEvent,
    EdgeTraversedEvent,
    Edge,
    Graph,
    GraphKind,
    Node,
    NodeRuntimeStateWire,
    ObservabilityEvent,
} from '@fabritorio/types';
import { STARTER_IDS } from '@fabritorio/types';
import type { Fragment } from './subgraph';
import { getStreamHub } from './stream-hub';

export interface StreamSubscription {
    close(): void;
}

export type LockState = 'idle' | 'running';

export type GraphLiveness = 'running' | 'idle' | 'stopped';

export interface GraphSummary {
    id: string;
    graph: Graph;
    status: LockState;
    liveness: GraphLiveness;
    created_at: string;
    updated_at: string;
}

export interface HealthResponse {
    ok: boolean;
    version: string;
}

export interface ChannelSendResult {
    eventId: string;
    source: string;
    timestamp: number;
    convId?: string;
}

export interface AgentConversationSummary {
    convId: string;
    source: string;
    rootEventId: string;
    bytes: number;
    label?: string;
}

export interface AgentConversationsResult {
    agentId: string;
    conversations: AgentConversationSummary[];
}

export interface ChannelReplayResult {
    source: string;
    roots: string[];
    events: Array<DispatchEvent | ObservabilityEvent>;
}

export interface TriggerRunSummary {
    eventId: string;
    timestamp: number;
    status: string;
    downstream: string[];
}

export interface TriggerRunsResult {
    source: string;
    runs: TriggerRunSummary[];
}

export interface TriggerRunDetail {
    events: Array<DispatchEvent | ObservabilityEvent>;
}

export interface AgentCallsResult {
    callerNodeId: string;
    calls: AskCallSummary[];
}

export interface RawResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    durationMs: number;
}

export interface IntrospectResult {
    id: string;
    status: LockState;
    sources: string[];
    subscriptions: string[];
    running: NodeRuntimeStateWire[];
}

export interface GraphStatusEvent {
    running: NodeRuntimeStateWire[];
}

export interface AskStartedEvent {
    eventId: string;
    askCallId: string;
    callerNodeId: string;
    calleeNodeId: string;
    brief: string;
    startedAt: number;
}

export interface AskCompletedEvent {
    eventId: string;
    askCallId: string;
    status: 'ok' | 'failed';
    durationMs: number | null;
    resultSnippet: string;
}

export interface AskStreamHandlers {
    started(ev: AskStartedEvent): void;
    completed(ev: AskCompletedEvent): void;
}

export interface DispatchStreamEvent {
    seq: number;
    kind: 'dispatch' | 'observability';
    payload: DispatchEvent | ObservabilityEvent;
}

export interface DispatchStreamEnd {
    reason: 'success' | 'stopped';
    terminalSeq: number;
}

export interface DispatchStreamHandlers {
    event(env: DispatchStreamEvent): void;
    end(payload: DispatchStreamEnd): void;
}

export interface ObservabilityReplayResult {
    events: DispatchStreamEvent[];
    max: number;
}

export interface ObservabilityStreamHandlers {
    event(env: DispatchStreamEvent): void;
    error?(err: Event): void;
}

export interface AnimationStreamHandlers {
    event(ev: EdgeTraversedEvent): void;
    error?(err: Event): void;
}

export interface MemorySnapshot {
    nodeId: string;
    entries: Record<string, unknown>;
}

export interface MemoryFile {
    nodeId: string;
    content: string;
}

export interface ToolConfigField {
    name: string;
    kind: 'enum' | 'string';
    label: string;
    description?: string;
    options?: string[];
    placeholder?: string;
    showWhen?: { field: string; equals: string };
    required?: boolean;
}

export interface ToolSpecSummary {
    name: string;
    description: string;
    source?: 'builtin' | 'runtime';
    config_schema?: ToolConfigField[];
}

export interface SkillSummary {
    name: string;
    description: string;
    path?: string;
}

export interface SkillDetail {
    skill: {
        name: string;
        description: string;
        body: string;
        path?: string;
        resources?: { name: string; path: string }[];
        allowed_tools?: string[];
    };
    raw: string;
}

export type GraphDraft = Omit<Graph, 'id' | 'created_at' | 'updated_at'>;

export type OpPlaceholder = string;

export interface AddNodeOp {
    op: 'add_node';
    kind: Node['type'];
    config?: Record<string, unknown>;
    position?: { x: number; y: number };
    as?: OpPlaceholder;
}

export interface AddEdgeOp {
    op: 'add_edge';
    source: string | OpPlaceholder;
    target: string | OpPlaceholder;
    source_port?: string;
    target_port?: string;
    topic?: string;
    priority?: number;
}

export interface UpdateNodeConfigOp {
    op: 'update_node_config';
    id: string;
    patch: Record<string, unknown>;
}

export interface DeleteNodeOp {
    op: 'delete_node';
    id: string;
}

export interface DeleteEdgeOp {
    op: 'delete_edge';
    id: string;
}

export type GraphOp = AddNodeOp | AddEdgeOp | UpdateNodeConfigOp | DeleteNodeOp | DeleteEdgeOp;

export type GraphOpResult =
    | { op: 'add_node'; ok: true; node: Node }
    | { op: 'add_edge'; ok: true; edge: Edge }
    | { op: 'update_node_config'; ok: true; node: Node }
    | { op: 'delete_node'; ok: true; id: string; cascadedEdgeIds: string[] }
    | { op: 'delete_edge'; ok: true; id: string };

export interface ParentContextResult {
    parentGraphId: string | null;
    parentAgentNodeId: string | null;
    nodes: Node[];
    edges: Edge[];
}

export interface DebugProbeState {
    graphId: string;
    nodeId: string;
    attachedTo: string | null;
    haltOn: 'pre' | 'post' | 'both';
    enabled: boolean;
    pending: DebugProbeHaltEvent | null;
}

export interface DebugProbeHaltEvent {
    probeNodeId: string;
    attachedTo: string;
    phase: 'pre' | 'post';
    eventId: string;
    observabilityType: string;
    ts: string;
}

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny';

export interface PermissionDecisionRequest {
    permissionNodeId: string;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    argSignature?: string;
    ts: string;
}

export interface PermissionGateState {
    graphId: string;
    nodeId: string;
    pending: PermissionDecisionRequest[];
}

export interface RunnerClient {
    baseUrl: string;
    getHealth(): Promise<HealthResponse>;
    createGraph(graph: GraphDraft): Promise<GraphSummary>;
    listGraphs(filter?: { kind?: GraphKind }): Promise<GraphSummary[]>;
    getGraph(id: string): Promise<GraphSummary | null>;
    updateGraph(id: string, graph: GraphDraft): Promise<GraphSummary | null>;
    renameGraph(
        id: string,
        patch: { name?: string; description?: string },
    ): Promise<GraphSummary | null>;
    deleteGraph(id: string): Promise<boolean>;
    instantiateGraph(templateId: string): Promise<GraphSummary>;
    createGraphFromStarter(kind: GraphKind, opts?: { name?: string }): Promise<GraphSummary>;
    cloneGraph(sourceId: string): Promise<GraphSummary>;
    cloneSubtree(
        destinationGraphId: string,
        fragment: { nodes: Node[]; edges: Edge[] },
    ): Promise<{ graph: Graph; remap: Record<string, string> }>;
    saveFragment(fragment: Fragment & { name: string }): Promise<GraphSummary>;
    applyGraphOps(
        graphId: string,
        ops: GraphOp[],
    ): Promise<{ graph: Graph; remap: Record<string, string>; results: GraphOpResult[] }>;
    activateGraph(id: string): Promise<void>;
    stopGraph(id: string): Promise<void>;
    stopDispatch(eventId: string): Promise<{ ok: boolean }>;
    resumeGraph(id: string): Promise<void>;
    loadGraph(id: string): Promise<IntrospectResult | null>;
    unloadGraph(id: string): Promise<boolean>;
    introspectGraph(id: string): Promise<IntrospectResult | null>;
    getParentContext(l1Id: string): Promise<ParentContextResult>;
    graphStatusStream(id: string, onEvent: (ev: GraphStatusEvent) => void): StreamSubscription;
    channelSendMessage(
        channelNodeId: string,
        content: string,
        opts?: { source?: string; convId?: string },
    ): Promise<ChannelSendResult>;
    agentConversations(graphId: string, agentId: string): Promise<AgentConversationsResult>;
    deleteConversation(graphId: string, agentId: string, convId: string): Promise<void>;
    renameConversation(
        graphId: string,
        agentId: string,
        convId: string,
        label: string,
    ): Promise<void>;
    channelStream(channelNodeId: string, onEvent: (ev: DispatchEvent) => void): EventSource;
    channelReplay(channelNodeId: string, source?: string): Promise<ChannelReplayResult>;
    debugSendMessage(
        graphId: string,
        debugNodeId: string,
        content: string,
    ): Promise<ChannelSendResult>;
    debugStream(
        graphId: string,
        debugNodeId: string,
        onEvent: (ev: DispatchEvent) => void,
    ): EventSource;
    debugReplay(
        graphId: string,
        debugNodeId: string,
        source?: string,
    ): Promise<ChannelReplayResult>;
    debugProbeState(graphId: string, probeNodeId: string): Promise<DebugProbeState | null>;
    debugProbeResume(graphId: string, probeNodeId: string): Promise<boolean>;
    debugProbeEnable(graphId: string, probeNodeId: string): Promise<boolean>;
    debugProbeDisable(graphId: string, probeNodeId: string): Promise<boolean>;
    debugProbeStream(
        graphId: string,
        probeNodeId: string,
        onEvent: (ev: DebugProbeHaltEvent) => void,
    ): EventSource;
    permissionGateState(
        graphId: string,
        permissionNodeId: string,
    ): Promise<PermissionGateState | null>;
    permissionGateDecide(
        graphId: string,
        permissionNodeId: string,
        callId: string,
        decision: PermissionDecision,
    ): Promise<boolean>;
    permissionGateStream(
        graphId: string,
        permissionNodeId: string,
        onEvent: (req: PermissionDecisionRequest) => void,
    ): StreamSubscription;
    getMemory(memoryNodeId: string): Promise<MemorySnapshot | null>;
    setMemoryKey(memoryNodeId: string, key: string, value: unknown): Promise<boolean>;
    deleteMemoryKey(memoryNodeId: string, key: string): Promise<boolean>;
    getMemoryFile(memoryNodeId: string): Promise<MemoryFile>;
    putMemoryFile(memoryNodeId: string, content: string): Promise<MemoryFile>;
    deleteMemoryFile(memoryNodeId: string): Promise<void>;
    triggerRuns(
        graphId: string,
        nodeId: string,
        opts?: { before?: string; limit?: number },
    ): Promise<TriggerRunsResult>;
    triggerRun(graphId: string, nodeId: string, eventId: string): Promise<TriggerRunDetail>;
    agentCalls(
        graphId: string,
        nodeId: string,
        opts?: { before?: string; limit?: number },
    ): Promise<AgentCallsResult>;
    agentCallDetail(graphId: string, nodeId: string, eventId: string): Promise<AskCallDetail>;
    agentAsksStream(
        graphId: string,
        nodeId: string,
        handlers: AskStreamHandlers,
    ): StreamSubscription;
    dispatchStream(
        graphId: string,
        eventId: string,
        handlers: DispatchStreamHandlers,
    ): StreamSubscription;
    observabilityStream(handlers: ObservabilityStreamHandlers): StreamSubscription;
    observabilityReplay(opts?: { tail?: number }): Promise<ObservabilityReplayResult>;
    animationStream(handlers: AnimationStreamHandlers): StreamSubscription;
    listTools(): Promise<ToolSpecSummary[]>;
    listSkills(): Promise<SkillSummary[]>;
    getSkill(name: string): Promise<SkillDetail | null>;
    saveSkill(name: string, content: string): Promise<SkillDetail>;
    rawFetch(method: string, path: string, body?: unknown): Promise<RawResponse>;
}

const WEB_DEV_PORT = '3000';
const RUNNER_DEV_PORT = '4000';

export function getDefaultBaseUrl(): string {
    const origin = resolveApiOrigin();
    return `${origin.replace(/\/$/, '')}/api`;
}

function resolveApiOrigin(): string {
    if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_RUNNER_URL) {
        return process.env.NEXT_PUBLIC_RUNNER_URL;
    }
    if (typeof window !== 'undefined') {
        const { protocol, hostname, port, origin } = window.location;
        if (port === WEB_DEV_PORT) return `${protocol}//${hostname}:${RUNNER_DEV_PORT}`;
        return origin;
    }
    return 'http://localhost:4000';
}

const tokenCache = new Map<string, Promise<string>>();
const resolvedTokens = new Map<string, string>();

function apiBaseOf(url: string): string {
    const idx = url.indexOf('/api/');
    if (idx !== -1) return url.slice(0, idx + 4);
    if (url.endsWith('/api')) return url;
    return getDefaultBaseUrl();
}

async function getToken(url: string): Promise<string | undefined> {
    const base = apiBaseOf(url);
    let pending = tokenCache.get(base);
    if (!pending) {
        pending = (async () => {
            const res = await fetch(`${base}/bootstrap`, {
                headers: { 'content-type': 'application/json' },
            });
            if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
            const body = (await res.json()) as { token: string };
            resolvedTokens.set(base, body.token);
            return body.token;
        })();
        pending.catch(() => tokenCache.delete(base));
        tokenCache.set(base, pending);
    }
    try {
        return await pending;
    } catch {
        return undefined;
    }
}

async function tokenFetch(url: string, init?: RequestInit): Promise<Response> {
    const token = await getToken(url);
    return fetch(url, {
        ...init,
        headers: {
            ...(token ? { 'x-fabritorio-token': token } : {}),
            ...init?.headers,
        },
    });
}

function withToken(url: string, token: string | undefined): string {
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function sseUrl(url: string): string {
    const base = apiBaseOf(url);
    const cached = resolvedTokens.get(base);
    if (cached) return withToken(url, cached);
    void getToken(url);
    return url;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const token = await getToken(url);
    const res = await tokenFetch(url, {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...(token ? { 'x-fabritorio-token': token } : {}),
            ...init?.headers,
        },
    });
    if (!res.ok) {
        let detail = '';
        try {
            detail = await res.text();
        } catch {
            /* ignore */
        }
        throw new Error(
            `runner ${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${detail}`,
        );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
}

async function requestJsonOrNull<T>(url: string, init?: RequestInit): Promise<T | null> {
    const token = await getToken(url);
    const res = await tokenFetch(url, {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...(token ? { 'x-fabritorio-token': token } : {}),
            ...init?.headers,
        },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
        let detail = '';
        try {
            detail = await res.text();
        } catch {
            /* ignore */
        }
        throw new Error(
            `runner ${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${detail}`,
        );
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
}

function summaryFromGraph(
    graph: Graph,
    status: LockState = 'idle',
    liveness: GraphLiveness = 'idle',
): GraphSummary {
    if (!graph.id) {
        throw new Error('graph from runner missing id');
    }
    return {
        id: graph.id,
        graph,
        status,
        liveness,
        created_at: graph.created_at ?? '',
        updated_at: graph.updated_at ?? '',
    };
}

interface AskStartedInfo {
    askCallId: string;
    callerNodeId: string;
    calleeNodeId: string;
    startedAt: number;
}

const ASK_SNIPPET_MAX = 240;

const DISPATCH_LIVE_SEQ_BASE = 1_000_000;

function askSnippet(text: string): string {
    if (text.length <= ASK_SNIPPET_MAX) return text;
    return `${text.slice(0, ASK_SNIPPET_MAX)}…`;
}

function firstUserContent(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
    for (const m of messages) {
        if (m.role === 'user' && typeof m.content === 'string') return m.content;
    }
    const first = messages[0];
    return first && typeof first.content === 'string' ? first.content : '';
}

function lastMessageContent(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
    const last = messages[messages.length - 1];
    return last && typeof last.content === 'string' ? last.content : '';
}

export function createRunnerClient(baseUrl = getDefaultBaseUrl()): RunnerClient {
    return {
        baseUrl,
        async getHealth() {
            return requestJson<HealthResponse>(`${baseUrl}/health`);
        },
        async createGraph(draft) {
            const res = await requestJson<{ graph: Graph }>(`${baseUrl}/graphs`, {
                method: 'POST',
                body: JSON.stringify(draft),
            });
            return summaryFromGraph(res.graph);
        },
        async listGraphs(filter) {
            const qs = filter?.kind ? `?kind=${encodeURIComponent(filter.kind)}` : '';
            const res = await requestJson<{ graphs: Array<Graph & { status?: GraphLiveness }> }>(
                `${baseUrl}/graphs${qs}`,
            );
            return res.graphs.map((g) => {
                const { status, ...graph } = g;
                return summaryFromGraph(graph, 'idle', status ?? 'idle');
            });
        },
        async getGraph(id) {
            const res = await requestJsonOrNull<{ graph: Graph }>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}`,
            );
            return res ? summaryFromGraph(res.graph) : null;
        },
        async updateGraph(id, draft) {
            const res = await requestJsonOrNull<{ graph: Graph }>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}`,
                { method: 'PUT', body: JSON.stringify(draft) },
            );
            return res ? summaryFromGraph(res.graph) : null;
        },
        async renameGraph(id, patch) {
            const res = await requestJsonOrNull<{ graph: Graph }>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}`,
                { method: 'PATCH', body: JSON.stringify(patch) },
            );
            return res ? summaryFromGraph(res.graph) : null;
        },
        async deleteGraph(id) {
            const res = await tokenFetch(`${baseUrl}/graphs/${encodeURIComponent(id)}`, {
                method: 'DELETE',
            });
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(
                    `runner DELETE /graphs/${id} failed: ${res.status} ${res.statusText}`,
                );
            }
            return true;
        },
        async instantiateGraph(templateId) {
            const res = await requestJson<{ graph: Graph }>(
                `${baseUrl}/graphs/${encodeURIComponent(templateId)}/instantiate`,
                { method: 'POST', body: '{}' },
            );
            return summaryFromGraph(res.graph);
        },
        async createGraphFromStarter(kind, opts) {
            const templateId = STARTER_IDS[kind];
            const res = await requestJson<{ graph: Graph }>(
                `${baseUrl}/graphs/${encodeURIComponent(templateId)}/instantiate`,
                { method: 'POST', body: '{}' },
            );
            const summary = summaryFromGraph(res.graph);
            if (opts?.name && opts.name.trim().length > 0 && summary.graph.name !== opts.name) {
                const renamed = await requestJson<{ graph: Graph }>(
                    `${baseUrl}/graphs/${encodeURIComponent(summary.id)}`,
                    {
                        method: 'PUT',
                        body: JSON.stringify({
                            kind: summary.graph.kind,
                            name: opts.name,
                            ...(summary.graph.description !== undefined
                                ? { description: summary.graph.description }
                                : {}),
                            nodes: summary.graph.nodes,
                            edges: summary.graph.edges,
                        }),
                    },
                );
                return summaryFromGraph(renamed.graph);
            }
            return summary;
        },
        async cloneGraph(sourceId) {
            const res = await requestJson<{ graph: Graph }>(
                `${baseUrl}/graphs/${encodeURIComponent(sourceId)}/clone`,
                { method: 'POST', body: '{}' },
            );
            return summaryFromGraph(res.graph);
        },
        async cloneSubtree(destinationGraphId, fragment) {
            return requestJson<{ graph: Graph; remap: Record<string, string> }>(
                `${baseUrl}/graphs/${encodeURIComponent(destinationGraphId)}/clone-subtree`,
                { method: 'POST', body: JSON.stringify(fragment) },
            );
        },
        async saveFragment(fragment) {
            const res = await requestJson<{ graph: Graph }>(`${baseUrl}/graphs/save-fragment`, {
                method: 'POST',
                body: JSON.stringify(fragment),
            });
            return summaryFromGraph(res.graph);
        },
        async applyGraphOps(graphId, ops) {
            const res = await requestJson<{
                graph: Graph;
                remap: Record<string, string>;
                results: GraphOpResult[];
            }>(`${baseUrl}/graphs/${encodeURIComponent(graphId)}/ops`, {
                method: 'POST',
                body: JSON.stringify({ ops }),
            });
            return res;
        },
        async activateGraph(id) {
            await requestJson<{ id: string; status: string }>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}/activate`,
                { method: 'POST', body: '{}' },
            );
        },
        async stopGraph(id) {
            await requestJson<{ id: string; status: string }>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}/stop`,
                { method: 'POST', body: '{}' },
            );
        },
        async resumeGraph(id) {
            await requestJson<{ id: string; status: string }>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}/resume`,
                { method: 'POST', body: '{}' },
            );
        },
        async stopDispatch(eventId) {
            const res = await requestJsonOrNull<{ ok: boolean }>(
                `${baseUrl}/dispatches/${encodeURIComponent(eventId)}/stop`,
                { method: 'POST', body: '{}' },
            );
            return res ?? { ok: false };
        },
        async loadGraph(id) {
            return requestJsonOrNull<IntrospectResult>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}/load`,
                { method: 'POST', body: '{}' },
            );
        },
        async unloadGraph(id) {
            const res = await tokenFetch(`${baseUrl}/graphs/${encodeURIComponent(id)}/unload`, {
                method: 'POST',
                body: '{}',
                headers: { 'content-type': 'application/json' },
            });
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(
                    `runner POST /graphs/${id}/unload failed: ${res.status} ${res.statusText}`,
                );
            }
            return true;
        },
        async introspectGraph(id) {
            return requestJsonOrNull<IntrospectResult>(
                `${baseUrl}/graphs/${encodeURIComponent(id)}/introspect`,
            );
        },
        async getParentContext(l1Id) {
            return requestJson<ParentContextResult>(
                `${baseUrl}/graphs/${encodeURIComponent(l1Id)}/parent-context`,
            );
        },
        graphStatusStream(id, onEvent) {
            const off = getStreamHub(baseUrl).on(`status:${id}`, (payload) => {
                onEvent(payload as GraphStatusEvent);
            });
            return { close: off };
        },
        async channelSendMessage(channelNodeId, content, opts) {
            return requestJson<ChannelSendResult>(
                `${baseUrl}/channels/webchat/${encodeURIComponent(channelNodeId)}/message`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        content,
                        ...(opts?.source ? { source: opts.source } : {}),
                        ...(opts?.convId ? { convId: opts.convId } : {}),
                    }),
                },
            );
        },
        async agentConversations(graphId, agentId) {
            return requestJson<AgentConversationsResult>(
                `${baseUrl}/agents/${encodeURIComponent(graphId)}/${encodeURIComponent(agentId)}/conversations`,
            );
        },
        async deleteConversation(graphId, agentId, convId) {
            const res = await tokenFetch(
                `${baseUrl}/agents/${encodeURIComponent(graphId)}/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(convId)}`,
                { method: 'DELETE' },
            );
            if (!res.ok) {
                throw new Error(
                    `runner DELETE /conversations failed: ${res.status} ${res.statusText}`,
                );
            }
        },
        async renameConversation(graphId, agentId, convId, label) {
            const res = await tokenFetch(
                `${baseUrl}/agents/${encodeURIComponent(graphId)}/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(convId)}/label`,
                {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ label }),
                },
            );
            if (!res.ok) {
                throw new Error(
                    `runner PUT /conversations label failed: ${res.status} ${res.statusText}`,
                );
            }
        },
        channelStream(channelNodeId, onEvent) {
            const source = new EventSource(
                sseUrl(`${baseUrl}/channels/webchat/${encodeURIComponent(channelNodeId)}/stream`),
            );
            source.onmessage = (ev: MessageEvent<string>) => {
                try {
                    const parsed = JSON.parse(ev.data) as DispatchEvent;
                    onEvent(parsed);
                } catch {
                    /* ignore malformed frames */
                }
            };
            return source;
        },
        async channelReplay(channelNodeId, source) {
            const qs = source ? `?source=${encodeURIComponent(source)}` : '';
            return requestJson<ChannelReplayResult>(
                `${baseUrl}/channels/webchat/${encodeURIComponent(channelNodeId)}/replay${qs}`,
            );
        },
        async debugSendMessage(graphId, debugNodeId, content) {
            return requestJson<ChannelSendResult>(
                `${baseUrl}/debug/${encodeURIComponent(graphId)}/${encodeURIComponent(debugNodeId)}/message`,
                { method: 'POST', body: JSON.stringify({ content }) },
            );
        },
        debugStream(graphId, debugNodeId, onEvent) {
            const source = new EventSource(
                sseUrl(
                    `${baseUrl}/debug/${encodeURIComponent(graphId)}/${encodeURIComponent(debugNodeId)}/stream`,
                ),
            );
            source.onmessage = (ev: MessageEvent<string>) => {
                try {
                    const parsed = JSON.parse(ev.data) as DispatchEvent;
                    onEvent(parsed);
                } catch {
                    /* ignore malformed frames */
                }
            };
            return source;
        },
        async debugReplay(graphId, debugNodeId, source) {
            const qs = source ? `?source=${encodeURIComponent(source)}` : '';
            return requestJson<ChannelReplayResult>(
                `${baseUrl}/debug/${encodeURIComponent(graphId)}/${encodeURIComponent(debugNodeId)}/replay${qs}`,
            );
        },
        async debugProbeState(graphId, probeNodeId) {
            return requestJsonOrNull<DebugProbeState>(
                `${baseUrl}/debug-probe/${encodeURIComponent(graphId)}/${encodeURIComponent(probeNodeId)}/state`,
            );
        },
        async debugProbeResume(graphId, probeNodeId) {
            const res = await tokenFetch(
                `${baseUrl}/debug-probe/${encodeURIComponent(graphId)}/${encodeURIComponent(probeNodeId)}/resume`,
                { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
            );
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(
                    `runner POST /debug-probe/.../resume failed: ${res.status} ${res.statusText}`,
                );
            }
            return true;
        },
        async debugProbeEnable(graphId, probeNodeId) {
            const res = await tokenFetch(
                `${baseUrl}/debug-probe/${encodeURIComponent(graphId)}/${encodeURIComponent(probeNodeId)}/enable`,
                { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
            );
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(
                    `runner POST /debug-probe/.../enable failed: ${res.status} ${res.statusText}`,
                );
            }
            return true;
        },
        async debugProbeDisable(graphId, probeNodeId) {
            const res = await tokenFetch(
                `${baseUrl}/debug-probe/${encodeURIComponent(graphId)}/${encodeURIComponent(probeNodeId)}/disable`,
                { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
            );
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(
                    `runner POST /debug-probe/.../disable failed: ${res.status} ${res.statusText}`,
                );
            }
            return true;
        },
        debugProbeStream(graphId, probeNodeId, onEvent) {
            const source = new EventSource(
                sseUrl(
                    `${baseUrl}/debug-probe/${encodeURIComponent(graphId)}/${encodeURIComponent(probeNodeId)}/stream`,
                ),
            );
            source.onmessage = (ev: MessageEvent<string>) => {
                try {
                    const parsed = JSON.parse(ev.data) as DebugProbeHaltEvent;
                    onEvent(parsed);
                } catch {
                    /* ignore malformed frames */
                }
            };
            return source;
        },
        async permissionGateState(graphId, permissionNodeId) {
            return requestJsonOrNull<PermissionGateState>(
                `${baseUrl}/permission/${encodeURIComponent(graphId)}/${encodeURIComponent(permissionNodeId)}/state`,
            );
        },
        async permissionGateDecide(graphId, permissionNodeId, callId, decision) {
            const res = await tokenFetch(
                `${baseUrl}/permission/${encodeURIComponent(graphId)}/${encodeURIComponent(permissionNodeId)}/decide`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ call_id: callId, decision }),
                },
            );
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(
                    `runner POST /permission/.../decide failed: ${res.status} ${res.statusText}`,
                );
            }
            return true;
        },
        permissionGateStream(graphId, permissionNodeId, onEvent) {
            const off = getStreamHub(baseUrl).on(
                `permission:${graphId}:${permissionNodeId}`,
                (payload) => {
                    onEvent(payload as PermissionDecisionRequest);
                },
            );
            return { close: off };
        },
        async getMemory(memoryNodeId) {
            return requestJsonOrNull<MemorySnapshot>(
                `${baseUrl}/memory/${encodeURIComponent(memoryNodeId)}`,
            );
        },
        async setMemoryKey(memoryNodeId, key, value) {
            const res = await tokenFetch(
                `${baseUrl}/memory/${encodeURIComponent(memoryNodeId)}/${encodeURIComponent(key)}`,
                {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(value),
                },
            );
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(`runner PUT /memory failed: ${res.status} ${res.statusText}`);
            }
            return true;
        },
        async deleteMemoryKey(memoryNodeId, key) {
            const res = await tokenFetch(
                `${baseUrl}/memory/${encodeURIComponent(memoryNodeId)}/${encodeURIComponent(key)}`,
                { method: 'DELETE' },
            );
            if (res.status === 404) return false;
            if (!res.ok) {
                throw new Error(`runner DELETE /memory failed: ${res.status} ${res.statusText}`);
            }
            return true;
        },
        async getMemoryFile(memoryNodeId) {
            return requestJson<MemoryFile>(
                `${baseUrl}/memory-file/${encodeURIComponent(memoryNodeId)}`,
            );
        },
        async putMemoryFile(memoryNodeId, content) {
            return requestJson<MemoryFile>(
                `${baseUrl}/memory-file/${encodeURIComponent(memoryNodeId)}`,
                { method: 'PUT', body: JSON.stringify({ content }) },
            );
        },
        async deleteMemoryFile(memoryNodeId) {
            await requestJson<void>(`${baseUrl}/memory-file/${encodeURIComponent(memoryNodeId)}`, {
                method: 'DELETE',
            });
        },
        async triggerRuns(graphId, nodeId, opts) {
            const params = new URLSearchParams();
            if (opts?.before) params.set('before', opts.before);
            if (typeof opts?.limit === 'number') params.set('limit', String(opts.limit));
            const qs = params.toString();
            return requestJson<TriggerRunsResult>(
                `${baseUrl}/triggers/${encodeURIComponent(graphId)}/${encodeURIComponent(nodeId)}/runs${qs ? `?${qs}` : ''}`,
            );
        },
        async triggerRun(graphId, nodeId, eventId) {
            return requestJson<TriggerRunDetail>(
                `${baseUrl}/triggers/${encodeURIComponent(graphId)}/${encodeURIComponent(nodeId)}/runs/${encodeURIComponent(eventId)}`,
            );
        },
        async agentCalls(graphId, nodeId, opts) {
            const params = new URLSearchParams();
            if (opts?.before) params.set('before', opts.before);
            if (typeof opts?.limit === 'number') params.set('limit', String(opts.limit));
            const qs = params.toString();
            return requestJson<AgentCallsResult>(
                `${baseUrl}/agents/${encodeURIComponent(graphId)}/${encodeURIComponent(nodeId)}/calls${qs ? `?${qs}` : ''}`,
            );
        },
        async agentCallDetail(graphId, nodeId, eventId) {
            return requestJson<AskCallDetail>(
                `${baseUrl}/agents/${encodeURIComponent(graphId)}/${encodeURIComponent(nodeId)}/calls/${encodeURIComponent(eventId)}`,
            );
        },
        async observabilityReplay(opts) {
            const params = new URLSearchParams();
            if (typeof opts?.tail === 'number') params.set('tail', String(opts.tail));
            const qs = params.toString();
            return requestJson<ObservabilityReplayResult>(
                `${baseUrl}/observability/replay${qs ? `?${qs}` : ''}`,
            );
        },
        agentAsksStream(graphId, nodeId, handlers) {
            const started = new Map<string, AskStartedInfo>();
            let stopped = false;
            void this.agentCalls(graphId, nodeId, { limit: 50 })
                .then((res) => {
                    if (stopped) return;
                    for (const call of res.calls) {
                        if (call.status !== 'running') continue;
                        if (started.has(call.eventId)) continue;
                        started.set(call.eventId, {
                            askCallId: call.askCallId,
                            callerNodeId: nodeId, // AgentCallsResult is scoped to this node
                            calleeNodeId: call.calleeNodeId,
                            startedAt: call.startedAt,
                        });
                        // Do NOT emit handlers.started — the modal already has
                        // these rows from its own agentCalls seed.
                    }
                })
                .catch(() => {
                    /* degrade: live-only; mid-flight completes for pre-existing calls just won't pair */
                });
            const off = getStreamHub(baseUrl).on('observability', (payload) => {
                const p = payload as Record<string, unknown>;
                if (p && p.snapshot === true) return;
                const env = payload as DispatchStreamEvent;
                if (!env || typeof env.seq !== 'number') return;
                if (env.kind === 'dispatch') {
                    const ev = env.payload as DispatchEvent;
                    const meta = ev.meta;
                    if (!meta) return;
                    const askCallId = meta.ask_call_id;
                    const callerNodeId = meta.ask_caller_node_id;
                    const calleeNodeId = meta.ask_callee_node_id;
                    if (typeof askCallId !== 'string') return;
                    if (typeof callerNodeId !== 'string') return;
                    if (typeof calleeNodeId !== 'string') return;
                    if (typeof meta.port === 'string') return;
                    if (started.has(ev.eventId)) return;
                    const startedAt = typeof ev.timestamp === 'number' ? ev.timestamp : Date.now();
                    started.set(ev.eventId, { askCallId, callerNodeId, calleeNodeId, startedAt });
                    handlers.started({
                        eventId: ev.eventId,
                        askCallId,
                        callerNodeId,
                        calleeNodeId,
                        brief: askSnippet(firstUserContent(ev.messages)),
                        startedAt,
                    });
                    return;
                }
                const ev = env.payload as ObservabilityEvent;
                if (ev.type !== 'output.emitted' && ev.type !== 'chain.stopped') return;
                const info = started.get(ev.eventId);
                if (!info) return;
                started.delete(ev.eventId);
                let status: AskCompletedEvent['status'];
                let resultSnippet: string;
                if (ev.type === 'output.emitted') {
                    status = ev.port === 'error' ? 'failed' : 'ok';
                    resultSnippet = askSnippet(lastMessageContent(ev.messages));
                } else {
                    status = 'failed';
                    resultSnippet = askSnippet(ev.reason ?? 'chain stopped');
                }
                const terminalTs = Date.parse(ev.ts);
                const durationMs = Number.isFinite(terminalTs) ? terminalTs - info.startedAt : null;
                handlers.completed({
                    eventId: ev.eventId,
                    askCallId: info.askCallId,
                    status,
                    durationMs,
                    resultSnippet,
                });
            });
            return {
                close: () => {
                    stopped = true;
                    off();
                },
            };
        },
        dispatchStream(_graphId, eventId, handlers) {
            const seen = new Set<string>();
            let localSeq = DISPATCH_LIVE_SEQ_BASE;
            let ended = false;
            const off = getStreamHub(baseUrl).on('observability', (payload) => {
                if (ended) return;
                const p = payload as Record<string, unknown>;
                if (p && p.snapshot === true) return;
                const env = payload as DispatchStreamEvent;
                if (!env || typeof env.seq !== 'number') return;
                if (env.payload.eventId !== eventId) return;
                const key = JSON.stringify(env.payload);
                if (seen.has(key)) return;
                seen.add(key);
                handlers.event({ seq: localSeq, kind: env.kind, payload: env.payload });
                if (env.kind === 'observability') {
                    const ev = env.payload as ObservabilityEvent;
                    if (ev.type === 'output.emitted' || ev.type === 'chain.stopped') {
                        const reason: DispatchStreamEnd['reason'] =
                            ev.type === 'chain.stopped' ? 'stopped' : 'success';
                        ended = true;
                        handlers.end({ reason, terminalSeq: localSeq });
                    }
                }
                localSeq++;
            });
            return { close: off };
        },
        observabilityStream(handlers) {
            const off = getStreamHub(baseUrl).on('observability', (payload) => {
                const p = payload as Record<string, unknown>;
                if (p && p.snapshot === true) return;
                handlers.event(payload as DispatchStreamEvent);
            });
            return { close: off };
        },
        animationStream(handlers) {
            const off = getStreamHub(baseUrl).on('animation', (payload) => {
                handlers.event(payload as EdgeTraversedEvent);
            });
            return { close: off };
        },
        async listTools() {
            const res = await requestJson<{ tools: ToolSpecSummary[] }>(`${baseUrl}/tools`);
            return res.tools;
        },
        async listSkills() {
            const res = await requestJson<{ skills: SkillSummary[] }>(`${baseUrl}/skills`);
            return res.skills;
        },
        async getSkill(name: string) {
            return requestJsonOrNull<SkillDetail>(`${baseUrl}/skills/${encodeURIComponent(name)}`);
        },
        async saveSkill(name: string, content: string) {
            return requestJson<SkillDetail>(`${baseUrl}/skills/${encodeURIComponent(name)}`, {
                method: 'PUT',
                body: JSON.stringify({ content }),
            });
        },
        async rawFetch(method, path, body) {
            const start = performance.now();
            const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
            const res = await tokenFetch(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
                method,
                ...(hasBody
                    ? {
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify(body),
                      }
                    : {}),
            });
            const durationMs = Math.round(performance.now() - start);
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => {
                headers[k] = v;
            });
            const contentType = res.headers.get('content-type') ?? '';
            let parsed: unknown;
            if (res.status === 204) {
                parsed = null;
            } else if (contentType.includes('application/json')) {
                try {
                    parsed = await res.json();
                } catch {
                    parsed = await res.text();
                }
            } else {
                parsed = await res.text();
            }
            return {
                status: res.status,
                statusText: res.statusText,
                headers,
                body: parsed,
                durationMs,
            };
        },
    };
}
