import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EdgeTraversedEvent } from '@fabritorio/types';
import type { EventBus } from '../runtime/event-bus.js';

export interface AnimationRoutesDeps {
    bus: EventBus;
}

export function registerAnimationRoutes(app: FastifyInstance, deps: AnimationRoutesDeps): void {
    app.get('/animation/stream', (req: FastifyRequest, reply: FastifyReply) => {
        const origin = req.headers.origin;
        reply.raw.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
        });
        reply.raw.write(':\n\n');

        const writeEvent = (event: EdgeTraversedEvent): void => {
            try {
                reply.raw.write(`event: event\n`);
                reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
                // socket gone — `close` will tidy up
            }
        };

        const offTraversal = deps.bus.subscribeTraversal(writeEvent);

        let detached = false;
        const close = () => {
            if (detached) return;
            detached = true;
            offTraversal();
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
