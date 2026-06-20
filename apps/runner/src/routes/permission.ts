import type { FastifyInstance } from 'fastify';
import type { PermissionDecision, PermissionGateRegistry } from '../runtime/permission.js';

export interface PermissionRoutesDeps {
    registry: PermissionGateRegistry;
}

interface GateParams {
    graphId: string;
    nodeId: string;
}

interface DecideBody {
    call_id?: string;
    decision?: PermissionDecision;
}

const VALID_DECISIONS: ReadonlySet<PermissionDecision> = new Set<PermissionDecision>([
    'allow-once',
    'allow-always',
    'deny',
]);

export function registerPermissionRoutes(app: FastifyInstance, deps: PermissionRoutesDeps): void {
    app.get<{ Params: GateParams }>('/permission/:graphId/:nodeId/state', async (req, reply) => {
        const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
        if (!handle) {
            return reply.code(404).send({ error: 'permission gate not loaded' });
        }
        return reply.send({
            graphId: handle.graphId,
            nodeId: handle.nodeId,
            pending: handle.pending(),
        });
    });

    app.post<{ Params: GateParams; Body: DecideBody }>(
        '/permission/:graphId/:nodeId/decide',
        async (req, reply) => {
            const handle = deps.registry.get(req.params.graphId, req.params.nodeId);
            if (!handle) {
                return reply.code(404).send({ error: 'permission gate not loaded' });
            }
            const body = req.body ?? {};
            const callId = typeof body.call_id === 'string' ? body.call_id : '';
            const decision = body.decision;
            if (!callId) {
                return reply.code(400).send({ error: 'call_id required' });
            }
            if (!decision || !VALID_DECISIONS.has(decision)) {
                return reply.code(400).send({
                    error: `decision must be one of ${[...VALID_DECISIONS].join(', ')}`,
                });
            }
            const ok = handle.decide(callId, decision);
            if (!ok) {
                return reply.code(404).send({ error: 'no pending request for call_id' });
            }
            return reply.code(202).send({ ok: true });
        },
    );
}
