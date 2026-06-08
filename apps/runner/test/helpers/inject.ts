import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';

export function inject(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
    const token = (app as Partial<FastifyInstance>).fabToken;
    return app.inject({
        ...opts,
        headers: {
            ...(token ? { 'x-fabritorio-token': token } : {}),
            ...opts.headers,
        },
    });
}
