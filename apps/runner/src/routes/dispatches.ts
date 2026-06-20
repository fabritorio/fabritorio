import type { FastifyInstance } from 'fastify';
import type { DispatchAbortRegistry } from '../runtime/dispatch-aborts.js';

export interface DispatchesRoutesDeps {
    dispatchAborts?: DispatchAbortRegistry;
}

interface StopParams {
    eventId: string;
}

export function registerDispatchesRoutes(app: FastifyInstance, deps: DispatchesRoutesDeps): void {
    app.post<{ Params: StopParams }>('/dispatches/:eventId/stop', (req, reply) => {
        const ok = deps.dispatchAborts?.abort(req.params.eventId) ?? false;
        return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: 'not running' });
    });
}
