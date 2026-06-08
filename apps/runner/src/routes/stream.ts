import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodeRuntimeStateWire } from '@fabritorio/types';
import type { EventBus } from '../runtime/event-bus.js';
import type { GraphRuntimeRegistry } from '../runtime/graph-runtime.js';
import type { PermissionGateRegistry } from '../runtime/permission.js';
import { writeSseHead } from '../runtime/sse.js';

export interface StreamRoutesDeps {
    bus: EventBus;
    runtimes: GraphRuntimeRegistry;
    permissionRegistry: PermissionGateRegistry;
}

export function registerStreamRoutes(app: FastifyInstance, deps: StreamRoutesDeps): void {
    app.get('/stream', (req: FastifyRequest, reply: FastifyReply) => {
        writeSseHead(req, reply);
        reply.raw.write(':\n\n');

        const write = (topic: string, payload: unknown): void => {
            try {
                reply.raw.write(`data: ${JSON.stringify({ topic, payload })}\n\n`);
            } catch {
                // socket gone — `close` will tidy up
            }
        };

        const offDispatch = deps.bus.subscribeDispatch((ev, seq) =>
            write('observability', { seq, kind: 'dispatch', payload: ev }),
        );
        const offObs = deps.bus.subscribeObservability((ev, seq) =>
            write('observability', { seq, kind: 'observability', payload: ev }),
        );

        const offTraversal = deps.bus.subscribeTraversal((ev) => write('animation', ev));

        for (const gid of deps.runtimes.listLoaded()) {
            const loaded = deps.runtimes.get(gid);
            if (!loaded) continue;
            const running: NodeRuntimeStateWire[] = [...loaded.nodeStates.values()];
            write(`status:${gid}`, { running });
        }
        const offStatus = deps.runtimes.subscribeAllNodeStates((gid, states) => {
            const running: NodeRuntimeStateWire[] = [...states.values()];
            write(`status:${gid}`, { running });
        });

        const offGates: Array<() => void> = [];
        for (const handle of deps.permissionRegistry.list()) {
            const topic = `permission:${handle.graphId}:${handle.nodeId}`;
            for (const seed of handle.pending()) {
                write(topic, seed);
            }
            offGates.push(handle.subscribe((permReq) => write(topic, permReq)));
        }

        let detached = false;
        const close = (): void => {
            if (detached) return;
            detached = true;
            offDispatch();
            offObs();
            offTraversal();
            offStatus();
            for (const off of offGates) off();
            try {
                reply.raw.end();
            } catch {
                // already closed
            }
        };
        req.raw.on('close', close);
        req.raw.on('error', close);

        return new Promise<void>((resolve) => {
            req.raw.on('close', () => resolve());
            req.raw.on('error', () => resolve());
        });
    });
}
