import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { inject } from './helpers/inject.js';

describe('GET /health', () => {
    it('returns 200 with ok=true and a version string', async () => {
        const app = buildServer({ logger: false });
        try {
            const res = await inject(app, { method: 'GET', url: '/api/health' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { ok: boolean; version: string };
            expect(body.ok).toBe(true);
            expect(typeof body.version).toBe('string');
            expect(body.version.length).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });
});
