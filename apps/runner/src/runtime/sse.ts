import type { FastifyReply, FastifyRequest } from 'fastify';

export function writeSseHead(req: FastifyRequest, reply: FastifyReply): void {
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    });
}
