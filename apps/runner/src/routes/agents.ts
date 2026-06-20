import type { FastifyInstance } from 'fastify';
import type {
    AskCallDetail,
    AskCallSummary,
    ChainStoppedEvent,
    DispatchEvent,
    Message,
    ObservabilityEvent,
    OutputEmittedEvent,
} from '@fabritorio/types';
import type { EventBus } from '../runtime/event-bus.js';
import type { EventLog } from '../runtime/event-log.js';
import type { ConversationLabelStore } from '../runtime/conversation-labels.js';
import type { GraphRuntimeRegistry } from '../runtime/graph-runtime.js';
import { ASK_AGENT_DEFAULT_TIMEOUT_MS } from '../runtime/builtin-tools.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SNIPPET_MAX = 240;

export interface AgentRoutesDeps {
    runtimes: GraphRuntimeRegistry;
    bus: EventBus;
    eventLog?: EventLog;
    conversationLabels: ConversationLabelStore;
}

interface CallsParams {
    graphId: string;
    nodeId: string;
}

interface CallsQuery {
    before?: string;
    limit?: string | number;
}

interface CallDetailParams extends CallsParams {
    eventId: string;
}

interface AskParts {
    callerNodeId: string;
    calleeNodeId: string;
}

function readAskParts(meta: Record<string, unknown> | undefined): AskParts | null {
    const caller = meta?.ask_caller_node_id;
    const callee = meta?.ask_callee_node_id;
    if (typeof caller !== 'string' || typeof callee !== 'string') return null;
    if (!caller || !callee) return null;
    return { callerNodeId: caller, calleeNodeId: callee };
}

function findRootDispatch(
    events: ReadonlyArray<DispatchEvent | ObservabilityEvent>,
    eventId: string,
): DispatchEvent | undefined {
    for (const event of events) {
        if (!('type' in event) && event.eventId === eventId && !event.parentId) {
            return event;
        }
    }
    return undefined;
}

function findTerminal(
    events: ReadonlyArray<DispatchEvent | ObservabilityEvent>,
): OutputEmittedEvent | ChainStoppedEvent | undefined {
    for (const event of events) {
        if (
            'type' in event &&
            (event.type === 'output.emitted' || event.type === 'chain.stopped')
        ) {
            return event;
        }
    }
    return undefined;
}

function firstUserContent(messages: ReadonlyArray<Message>): string {
    for (const m of messages) {
        if (m.role === 'user' && typeof m.content === 'string') return m.content;
    }
    const first = messages[0];
    return first && typeof first.content === 'string' ? first.content : '';
}

function lastMessageContent(messages: ReadonlyArray<Message>): string {
    const last = messages[messages.length - 1];
    return last && typeof last.content === 'string' ? last.content : '';
}

function snippet(text: string): string {
    if (text.length <= SNIPPET_MAX) return text;
    return `${text.slice(0, SNIPPET_MAX)}…`;
}

function readAskChain(meta: Record<string, unknown> | undefined): string[] {
    const raw = meta?.ask_chain;
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string');
}

function readTimeoutMs(meta: Record<string, unknown> | undefined): number {
    const raw = meta?.timeout_ms;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    return ASK_AGENT_DEFAULT_TIMEOUT_MS;
}

function summarize(
    bus: EventBus,
    rootEventId: string,
): { summary: AskCallSummary; root: DispatchEvent } | null {
    const events = bus.eventsByDispatch(rootEventId);
    const root = findRootDispatch(events, rootEventId);
    if (!root) return null;
    const parts = readAskParts(root.meta);
    if (!parts) return null;
    const askCallId =
        root.meta && typeof root.meta.ask_call_id === 'string'
            ? (root.meta.ask_call_id as string)
            : '';
    const briefSnippet = snippet(firstUserContent(root.messages));

    const terminal = findTerminal(events);
    let status: AskCallSummary['status'] = 'running';
    let durationMs: number | null = null;
    let resultSnippet: string | null = null;
    if (terminal) {
        if (terminal.type === 'output.emitted') {
            status = terminal.port === 'error' ? 'failed' : 'ok';
            resultSnippet = snippet(lastMessageContent(terminal.messages));
        } else {
            status = 'failed';
            resultSnippet = snippet(terminal.reason ?? 'chain stopped');
        }
        const terminalTs = Date.parse(terminal.ts);
        durationMs = Number.isFinite(terminalTs) ? terminalTs - root.timestamp : null;
    }

    return {
        root,
        summary: {
            eventId: rootEventId,
            askCallId,
            calleeNodeId: parts.calleeNodeId,
            status,
            startedAt: root.timestamp,
            durationMs,
            briefSnippet,
            resultSnippet,
        },
    };
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
    app.get<{ Params: CallsParams; Querystring: CallsQuery }>(
        '/agents/:graphId/:nodeId/calls',
        (req, reply) => {
            const loaded = deps.runtimes.get(req.params.graphId);
            if (!loaded) {
                return reply.code(404).send({ error: 'graph not loaded' });
            }
            const node = loaded.graph.nodes.find((n) => n.id === req.params.nodeId);
            if (!node) {
                return reply.code(404).send({ error: 'agent node not found' });
            }

            const prefix = `ask:${req.params.nodeId}->`;
            const rootIds = deps.bus.rootEventIdsBySourcePrefix(prefix).slice().reverse();

            const beforeTs =
                typeof req.query.before === 'string' && req.query.before.length > 0
                    ? Date.parse(req.query.before)
                    : Number.NaN;
            const hasBefore = Number.isFinite(beforeTs);

            const rawLimit =
                typeof req.query.limit === 'string'
                    ? Number.parseInt(req.query.limit, 10)
                    : typeof req.query.limit === 'number'
                      ? req.query.limit
                      : Number.NaN;
            const limit = Number.isFinite(rawLimit)
                ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
                : DEFAULT_LIMIT;

            const calls: AskCallSummary[] = [];
            for (const eventId of rootIds) {
                if (calls.length >= limit) break;
                const built = summarize(deps.bus, eventId);
                if (!built) continue;
                if (hasBefore && built.root.timestamp >= beforeTs) continue;
                calls.push(built.summary);
            }

            return reply.send({ callerNodeId: req.params.nodeId, calls });
        },
    );

    app.get<{ Params: CallDetailParams }>(
        '/agents/:graphId/:nodeId/calls/:eventId',
        (req, reply) => {
            const loaded = deps.runtimes.get(req.params.graphId);
            if (!loaded) {
                return reply.code(404).send({ error: 'graph not loaded' });
            }
            const node = loaded.graph.nodes.find((n) => n.id === req.params.nodeId);
            if (!node) {
                return reply.code(404).send({ error: 'agent node not found' });
            }

            const events = deps.bus.eventsByDispatch(req.params.eventId);
            const root = findRootDispatch(events, req.params.eventId);
            if (!root) {
                return reply.code(404).send({ error: 'event not found' });
            }
            const parts = readAskParts(root.meta);
            if (!parts || parts.callerNodeId !== req.params.nodeId) {
                return reply.code(404).send({ error: 'event not an outbound ask of this node' });
            }

            const terminal = findTerminal(events);
            let status: AskCallDetail['response']['status'] = 'running';
            let durationMs: number | null = null;
            let stdout = '';
            let exitCode = 0;
            if (terminal) {
                if (terminal.type === 'output.emitted') {
                    status = terminal.port === 'error' ? 'failed' : 'ok';
                    stdout = lastMessageContent(terminal.messages);
                } else {
                    status = 'failed';
                    stdout = terminal.reason ?? 'chain stopped';
                }
                exitCode = status === 'failed' ? 1 : 0;
                const terminalTs = Date.parse(terminal.ts);
                durationMs = Number.isFinite(terminalTs) ? terminalTs - root.timestamp : null;
            }

            const detail: AskCallDetail = {
                call: {
                    brief: firstUserContent(root.messages),
                    askChain: readAskChain(root.meta),
                    inheritSession: false,
                    timeoutMs: readTimeoutMs(root.meta),
                    calleeNodeId: parts.calleeNodeId,
                    callerNodeId: parts.callerNodeId,
                },
                response: {
                    stdout,
                    exitCode,
                    status,
                    durationMs,
                },
                internal: events,
            };

            return reply.send(detail);
        },
    );

    registerConversationsRoute(app, deps);
}

interface ConversationsParams {
    graphId: string;
    agentId: string;
}

interface ConversationSummary {
    convId: string;
    source: string;
    rootEventId: string;
    bytes: number;
    label?: string;
    // TODO(B6): derive preview/lastTs from the root dispatch / its events when
    // the FE needs richer conversation metadata. List endpoint stays cheap
    // (one index lookup, no per-root event scan).
}

function registerConversationsRoute(app: FastifyInstance, deps: AgentRoutesDeps): void {
    app.get<{ Params: ConversationsParams }>(
        '/agents/:graphId/:agentId/conversations',
        (req, reply) => {
            const loaded = deps.runtimes.get(req.params.graphId);
            if (!loaded) {
                return reply.code(404).send({ error: 'graph not loaded' });
            }
            const agent = loaded.graph.nodes.find((n) => n.id === req.params.agentId);
            if (!agent) {
                return reply.code(404).send({ error: 'agent node not found' });
            }
            const sidecar = loaded.graph.nodes.find(
                (n) => n.type === 'channel' && n.owner_node_id === req.params.agentId,
            );

            const prefix = `chat:${req.params.agentId}:`;
            const rootIds = sidecar
                ? deps.bus.rootEventIdsBySourcePrefix(prefix).slice().reverse()
                : [];

            const labels = deps.conversationLabels.getAllForGraph(req.params.graphId);

            const conversations: ConversationSummary[] = [];
            const byConvId = new Map<string, ConversationSummary>();
            for (const eventId of rootIds) {
                const events = deps.bus.eventsByDispatch(eventId);
                const root = findRootDispatch(events, eventId);
                if (!root) continue;
                if (!root.source.startsWith(prefix)) continue;
                const convId = root.source.slice(prefix.length);
                if (!convId) continue;
                let rootBytes = 0;
                for (const ev of events) {
                    rootBytes += Buffer.byteLength(JSON.stringify(ev), 'utf8');
                }
                const existing = byConvId.get(convId);
                if (existing) {
                    existing.bytes += rootBytes;
                    continue;
                }
                const label = labels[`${req.params.agentId}:${convId}`];
                const summary: ConversationSummary = {
                    convId,
                    source: root.source,
                    rootEventId: eventId,
                    bytes: rootBytes,
                    ...(label !== undefined ? { label } : {}),
                };
                byConvId.set(convId, summary);
                conversations.push(summary);
            }

            return reply.send({ agentId: req.params.agentId, conversations });
        },
    );

    registerDeleteConversationRoute(app, deps);
    registerConversationLabelRoute(app, deps);
}

interface ConversationLabelParams {
    graphId: string;
    agentId: string;
    convId: string;
}

function registerConversationLabelRoute(app: FastifyInstance, deps: AgentRoutesDeps): void {
    app.put<{ Params: ConversationLabelParams; Body: { label?: unknown } }>(
        '/agents/:graphId/:agentId/conversations/:convId/label',
        (req, reply) => {
            const { graphId, agentId, convId } = req.params;
            const label = (req.body ?? {}).label;
            if (typeof label !== 'string') {
                return reply.code(400).send({ error: 'label must be a string' });
            }
            deps.conversationLabels.set(graphId, agentId, convId, label);
            const stored = deps.conversationLabels.get(graphId, agentId, convId) ?? '';
            return reply.send({ graphId, agentId, convId, label: stored });
        },
    );
}

interface DeleteConversationParams {
    graphId: string;
    agentId: string;
    convId: string;
}

function registerDeleteConversationRoute(app: FastifyInstance, deps: AgentRoutesDeps): void {
    app.delete<{ Params: DeleteConversationParams }>(
        '/agents/:graphId/:agentId/conversations/:convId',
        async (req, reply) => {
            const loaded = deps.runtimes.get(req.params.graphId);
            if (!loaded) {
                return reply.code(404).send({ error: 'graph not loaded' });
            }
            const agent = loaded.graph.nodes.find((n) => n.id === req.params.agentId);
            if (!agent) {
                return reply.code(404).send({ error: 'agent node not found' });
            }
            const sidecar = loaded.graph.nodes.find(
                (n) => n.type === 'channel' && n.owner_node_id === req.params.agentId,
            );
            if (!sidecar) {
                return reply.code(204).send();
            }

            const source = `chat:${req.params.agentId}:${req.params.convId}`;
            const roots = deps.bus.rootEventIdsBySource(source);
            for (const eventId of roots) {
                deps.bus.forgetDispatch(eventId);
                await deps.eventLog?.delete(eventId);
            }
            deps.conversationLabels.delete(
                req.params.graphId,
                req.params.agentId,
                req.params.convId,
            );

            return reply.code(204).send();
        },
    );
}
