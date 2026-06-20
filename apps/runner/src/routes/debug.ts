import type { FastifyInstance } from 'fastify';
import type { DispatchEvent } from '@fabritorio/types';
import type { DebugGatewayRegistry } from '../runtime/debug.js';
import type { EventBus } from '../runtime/event-bus.js';
import { writeSseHead } from '../runtime/sse.js';

export interface DebugRoutesDeps {
    registry: DebugGatewayRegistry;
    bus: EventBus;
}

interface DebugParams {
    graphId: string;
    nodeId: string;
}

interface MessageBody {
    content?: unknown;
    source?: unknown;
}

export function registerDebugRoutes(app: FastifyInstance, deps: DebugRoutesDeps): void {
    app.post<{ Params: DebugParams; Body: MessageBody }>(
        '/debug/:graphId/:nodeId/message',
        async (req, reply) => {
            const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
            if (!handle) {
                return reply.code(404).send({ error: 'debug gateway not loaded' });
            }
            const body = (req.body ?? {}) as MessageBody;
            const content = typeof body.content === 'string' ? body.content : '';
            if (content.length === 0) {
                return reply.code(400).send({ error: 'content required' });
            }
            const source = typeof body.source === 'string' ? body.source : undefined;
            const event = await handle.publish({
                content,
                ...(source ? { source } : {}),
            });
            return reply.code(202).send({
                eventId: event.eventId,
                source: event.source,
                timestamp: event.timestamp,
            });
        },
    );

    app.get<{ Params: DebugParams }>('/debug/:graphId/:nodeId/stream', (req, reply) => {
        const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
        if (!handle) {
            reply.code(404).send({ error: 'debug gateway not loaded' });
            return reply;
        }

        writeSseHead(req, reply);
        reply.raw.write(`: connected\n\n`);

        const off = handle.subscribe((event: DispatchEvent) => {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const offTeardown = handle.onTeardown(() => {
            try {
                reply.raw.end();
            } catch {
                /* socket already closed */
            }
        });

        const close = () => {
            off();
            offTeardown();
            try {
                reply.raw.end();
            } catch {
                /* socket already closed */
            }
        };
        req.raw.on('close', close);
        req.raw.on('error', close);
        return reply;
    });

    app.get<{
        Params: DebugParams;
        Querystring: { source?: string };
    }>('/debug/:graphId/:nodeId/replay', (req, reply) => {
        const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
        if (!handle) {
            return reply.code(404).send({ error: 'debug gateway not loaded' });
        }
        const source =
            typeof req.query.source === 'string' && req.query.source.length > 0
                ? req.query.source
                : `debug:${req.params.nodeId}`;
        const roots = handle.rootsBySource(source);
        const events = roots.flatMap((eventId) => deps.bus.eventsByDispatch(eventId));
        return reply.send({ source, roots, events });
    });
}
