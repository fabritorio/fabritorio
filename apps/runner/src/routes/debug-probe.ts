import type { FastifyInstance } from 'fastify';
import type { DebugProbeRegistry } from '../runtime/debug-probe.js';

export interface DebugProbeRoutesDeps {
    registry: DebugProbeRegistry;
}

interface ProbeParams {
    graphId: string;
    nodeId: string;
}

export function registerDebugProbeRoutes(app: FastifyInstance, deps: DebugProbeRoutesDeps): void {
    app.get<{ Params: ProbeParams }>('/debug-probe/:graphId/:nodeId/state', async (req, reply) => {
        const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
        if (!handle) {
            return reply.code(404).send({ error: 'debug probe not loaded' });
        }
        return reply.send({
            graphId: handle.graphId,
            nodeId: handle.nodeId,
            attachedTo: handle.attachedTo ?? null,
            haltOn: handle.haltOn,
            enabled: handle.enabled,
            pending: handle.pending(),
        });
    });

    app.post<{ Params: ProbeParams }>(
        '/debug-probe/:graphId/:nodeId/resume',
        async (req, reply) => {
            const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
            if (!handle) {
                return reply.code(404).send({ error: 'debug probe not loaded' });
            }
            handle.resume();
            return reply.code(202).send({ ok: true });
        },
    );

    app.post<{ Params: ProbeParams }>(
        '/debug-probe/:graphId/:nodeId/enable',
        async (req, reply) => {
            const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
            if (!handle) {
                return reply.code(404).send({ error: 'debug probe not loaded' });
            }
            handle.setEnabled(true);
            return reply.send({ ok: true, enabled: handle.enabled });
        },
    );

    app.post<{ Params: ProbeParams }>(
        '/debug-probe/:graphId/:nodeId/disable',
        async (req, reply) => {
            const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
            if (!handle) {
                return reply.code(404).send({ error: 'debug probe not loaded' });
            }
            handle.setEnabled(false);
            return reply.send({ ok: true, enabled: handle.enabled });
        },
    );

    app.get<{ Params: ProbeParams }>('/debug-probe/:graphId/:nodeId/stream', (req, reply) => {
        const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
        if (!handle) {
            reply.code(404).send({ error: 'debug probe not loaded' });
            return reply;
        }

        const origin = req.headers.origin;
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
        });
        reply.raw.write(`: connected\n\n`);

        const seed = handle.pending();
        if (seed) {
            reply.raw.write(`data: ${JSON.stringify(seed)}\n\n`);
        }

        const off = handle.subscribe((ev) => {
            reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
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
}
