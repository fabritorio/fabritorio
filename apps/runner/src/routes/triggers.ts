import type { FastifyInstance } from 'fastify';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import type { EventBus } from '../runtime/event-bus.js';
import type { GraphRuntimeRegistry } from '../runtime/graph-runtime.js';
import type { ManualTriggerRegistry } from '../runtime/triggers/manual-registry.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface TriggerRoutesDeps {
    runtimes: GraphRuntimeRegistry;
    bus: EventBus;
    manualTriggers: ManualTriggerRegistry;
}

interface RunsParams {
    graphId: string;
    nodeId: string;
}

interface FireBody {
    message?: unknown;
}

interface RunsQuery {
    before?: string;
    limit?: string | number;
}

interface RunDetailParams extends RunsParams {
    eventId: string;
}

interface RunSummary {
    eventId: string;
    timestamp: number;
    status: 'ok' | 'failed' | 'halted';
    downstream: string[];
}

function deriveStatus(events: Array<DispatchEvent | ObservabilityEvent>): RunSummary['status'] {
    void events;
    return 'ok';
}

function derivedDownstream(events: Array<DispatchEvent | ObservabilityEvent>): string[] {
    const seen = new Set<string>();
    for (const event of events) {
        if ('type' in event && event.type === 'gateway.received') {
            seen.add(event.node_id);
        }
    }
    return [...seen];
}

function findRootDispatch(
    events: Array<DispatchEvent | ObservabilityEvent>,
    eventId: string,
): DispatchEvent | undefined {
    for (const event of events) {
        if (!('type' in event) && event.eventId === eventId && !event.parentId) {
            return event;
        }
    }
    return undefined;
}

export function registerTriggerRoutes(app: FastifyInstance, deps: TriggerRoutesDeps): void {
    app.get<{ Params: RunsParams; Querystring: RunsQuery }>(
        '/triggers/:graphId/:nodeId/runs',
        (req, reply) => {
            const loaded = deps.runtimes.get(req.params.graphId);
            if (!loaded) {
                return reply.code(404).send({ error: 'graph not loaded' });
            }
            const node = loaded.graph.nodes.find((n) => n.id === req.params.nodeId);
            if (!node || node.type !== 'trigger') {
                return reply.code(404).send({ error: 'trigger node not found' });
            }

            const source = `trigger:${req.params.nodeId}`;
            const rootIds = deps.bus.rootEventIdsBySource(source).slice().reverse();

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

            const runs: RunSummary[] = [];
            for (const eventId of rootIds) {
                if (runs.length >= limit) break;
                const events = deps.bus.eventsByDispatch(eventId);
                const root = findRootDispatch(events, eventId);
                if (!root) continue;
                if (hasBefore && root.timestamp >= beforeTs) continue;
                runs.push({
                    eventId,
                    timestamp: root.timestamp,
                    status: deriveStatus(events),
                    downstream: derivedDownstream(events),
                });
            }

            return reply.send({ source, runs });
        },
    );

    app.get<{ Params: RunDetailParams }>(
        '/triggers/:graphId/:nodeId/runs/:eventId',
        (req, reply) => {
            const loaded = deps.runtimes.get(req.params.graphId);
            if (!loaded) {
                return reply.code(404).send({ error: 'graph not loaded' });
            }
            const node = loaded.graph.nodes.find((n) => n.id === req.params.nodeId);
            if (!node || node.type !== 'trigger') {
                return reply.code(404).send({ error: 'trigger node not found' });
            }

            const source = `trigger:${req.params.nodeId}`;
            if (!deps.bus.rootEventIdsBySource(source).includes(req.params.eventId)) {
                return reply.code(404).send({ error: 'event not found for this trigger' });
            }

            return reply.send({ events: deps.bus.eventsByDispatch(req.params.eventId) });
        },
    );

    app.post<{ Params: RunsParams; Body: FireBody }>(
        '/triggers/:graphId/:nodeId/fire',
        async (req, reply) => {
            const { graphId, nodeId } = req.params;
            const loaded = deps.runtimes.get(graphId);
            if (!loaded) {
                return reply.code(404).send({ error: 'graph not loaded' });
            }
            const node = loaded.graph.nodes.find((n) => n.id === nodeId);
            if (!node || node.type !== 'trigger') {
                return reply.code(404).send({ error: 'trigger node not found' });
            }

            const trigger = deps.manualTriggers.get(nodeId);
            if (!trigger) {
                return reply.code(404).send({ error: 'trigger not loaded' });
            }

            const body = (req.body ?? {}) as FireBody;
            const message = typeof body.message === 'string' ? body.message : undefined;

            // Dispatch under the canonical `trigger:<nodeId>` source so the fired run
            // shows up in the trigger's run history (the /runs query keys off it), exactly
            // like cron/schedule do. Manual provenance is carried in meta, not the source.
            const event = await trigger.fire({
                source: `trigger:${nodeId}`,
                meta: { firedVia: 'manual' },
                ...(message !== undefined ? { message } : {}),
            });
            if (!event) {
                return reply.code(400).send({ error: 'content required' });
            }
            return reply.code(202).send({
                eventId: event.eventId,
                source: event.source,
                timestamp: event.timestamp,
            });
        },
    );
}
