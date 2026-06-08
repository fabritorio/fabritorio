import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { inject } from './helpers/inject.js';

describe('CORS', () => {
    it('echoes the configured origin on a cross-origin GET', async () => {
        const app = buildServer({
            logger: false,
            corsOrigin: 'http://localhost:3000',
        });
        try {
            const res = await inject(app, {
                method: 'GET',
                url: '/api/health',
                headers: { origin: 'http://localhost:3000' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
        } finally {
            await app.close();
        }
    });

    it('omits CORS headers when disabled', async () => {
        const app = buildServer({ logger: false, corsOrigin: false });
        try {
            const res = await inject(app, {
                method: 'GET',
                url: '/api/health',
                headers: { origin: 'http://localhost:3000' },
            });
            expect(res.headers['access-control-allow-origin']).toBeUndefined();
        } finally {
            await app.close();
        }
    });
});
