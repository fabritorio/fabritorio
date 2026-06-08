import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createDispatchAbortRegistry } from '../../src/runtime/dispatch-aborts.js';
import { inject } from '../helpers/inject.js';

describe('POST /dispatches/:eventId/stop', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-stop-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('404s for an unregistered eventId', async () => {
        const graphStore = createGraphStore({ dir });
        const dispatchAborts = createDispatchAbortRegistry();
        const app = buildServer({ logger: false, graphStore, dispatchAborts });
        try {
            const res = await inject(app, {
                method: 'POST',
                url: '/api/dispatches/nope/stop',
                payload: {},
            });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ error: 'not running' });
        } finally {
            await app.close();
        }
    });

    it('aborts a registered controller and returns { ok: true }', async () => {
        const graphStore = createGraphStore({ dir });
        const dispatchAborts = createDispatchAbortRegistry();
        const app = buildServer({ logger: false, graphStore, dispatchAborts });
        try {
            const controller = dispatchAborts.mint('evt-live');
            expect(controller.signal.aborted).toBe(false);

            const res = await inject(app, {
                method: 'POST',
                url: '/api/dispatches/evt-live/stop',
                payload: {},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ ok: true });
            expect(controller.signal.aborted).toBe(true);
        } finally {
            await app.close();
        }
    });
});
