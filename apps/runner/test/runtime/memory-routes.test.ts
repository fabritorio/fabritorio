import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { MemoryNode } from '@fabritorio/types';
import { registerMemoryRoutes } from '../../src/routes/memory.js';
import { createMemoryRegistry } from '../../src/runtime/memory.js';
import { inject } from '../helpers/inject.js';

function memNode(id: string): MemoryNode {
    return {
        id,
        type: 'memory',
        storage: 'in_memory',
        storage_kind: 'kv',
        handling: 'full_history',
        tool_access: 'none',
        position: { x: 0, y: 0 },
    };
}

function buildApp(memoryDir = mkdtempSync(join(tmpdir(), 'fabritorio-mem-routes-'))) {
    const memory = createMemoryRegistry({ localStorageDir: memoryDir });
    const app = Fastify({ logger: false });
    app.register(async (api) => registerMemoryRoutes(api, { memory, memoryDir }), {
        prefix: '/api',
    });
    return { app, memory, memoryDir };
}

describe('memory routes', () => {
    it('returns the snapshot for a resolved handle', async () => {
        const { app, memory } = buildApp();
        const handle = memory.resolve(memNode('mem-1'));
        handle.write('webchat:ch', [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'yo' },
        ]);
        try {
            const res = await inject(app, { method: 'GET', url: '/api/memory/mem-1' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
                nodeId: string;
                entries: Record<string, unknown>;
            };
            expect(body.nodeId).toBe('mem-1');
            expect(body.entries['webchat:ch']).toEqual([
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'yo' },
            ]);
        } finally {
            await app.close();
        }
    });

    it('PUT writes a value at the given key', async () => {
        const { app, memory } = buildApp();
        const handle = memory.resolve(memNode('mem-1'));
        try {
            const res = await inject(app, {
                method: 'PUT',
                url: '/api/memory/mem-1/webchat%3Ach',
                payload: [{ role: 'user', content: 'edited' }],
            });
            expect(res.statusCode).toBe(200);
            expect(handle.read('webchat:ch')).toEqual([{ role: 'user', content: 'edited' }]);
        } finally {
            await app.close();
        }
    });

    it('DELETE drops one key but leaves siblings', async () => {
        const { app, memory } = buildApp();
        const handle = memory.resolve(memNode('mem-1'));
        handle.write('a', 1);
        handle.write('b', 2);
        try {
            const res = await inject(app, {
                method: 'DELETE',
                url: '/api/memory/mem-1/a',
            });
            expect(res.statusCode).toBe(204);
            expect(handle.read('a')).toBeUndefined();
            expect(handle.read('b')).toBe(2);
        } finally {
            await app.close();
        }
    });

    it("404s when the memory node hasn't been resolved", async () => {
        const { app } = buildApp();
        try {
            const get = await inject(app, { method: 'GET', url: '/api/memory/mem-x' });
            expect(get.statusCode).toBe(404);
            const put = await inject(app, {
                method: 'PUT',
                url: '/api/memory/mem-x/k',
                payload: { v: 1 },
            });
            expect(put.statusCode).toBe(404);
            const del = await inject(app, {
                method: 'DELETE',
                url: '/api/memory/mem-x/k',
            });
            expect(del.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });
});

describe('memory-file routes', () => {
    it('GET returns empty content for a node with no file yet (no 404)', async () => {
        const { app } = buildApp();
        try {
            const res = await inject(app, { method: 'GET', url: '/api/memory-file/mem-md' });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ nodeId: 'mem-md', content: '' });
        } finally {
            await app.close();
        }
    });

    it('PUT writes the .md file on disk and GET reads it back — graph never loaded', async () => {
        const { app, memoryDir } = buildApp();
        try {
            const md = '# Notes\n\n- one\n- two\n';
            const put = await inject(app, {
                method: 'PUT',
                url: '/api/memory-file/mem-md',
                payload: { content: md },
            });
            expect(put.statusCode).toBe(200);
            expect(put.json()).toEqual({ nodeId: 'mem-md', content: md });
            expect(readFileSync(join(memoryDir, 'mem-md.md'), 'utf8')).toBe(md);

            const get = await inject(app, { method: 'GET', url: '/api/memory-file/mem-md' });
            expect((get.json() as { content: string }).content).toBe(md);
        } finally {
            rmSync(memoryDir, { recursive: true, force: true });
            await app.close();
        }
    });

    it('the markdown handle and the file route see the same bytes', async () => {
        const { app, memory, memoryDir } = buildApp();
        try {
            const handle = memory.resolve({
                ...memNode('mem-md'),
                storage: 'local_storage',
                storage_kind: 'markdown',
            });
            await inject(app, {
                method: 'PUT',
                url: '/api/memory-file/mem-md',
                payload: { content: 'shared blob' },
            });
            expect(handle.read('content')).toBe('shared blob');
        } finally {
            rmSync(memoryDir, { recursive: true, force: true });
            await app.close();
        }
    });

    it('DELETE removes the file', async () => {
        const { app, memoryDir } = buildApp();
        try {
            await inject(app, {
                method: 'PUT',
                url: '/api/memory-file/mem-md',
                payload: { content: 'x' },
            });
            const del = await inject(app, { method: 'DELETE', url: '/api/memory-file/mem-md' });
            expect(del.statusCode).toBe(204);
            const get = await inject(app, { method: 'GET', url: '/api/memory-file/mem-md' });
            expect((get.json() as { content: string }).content).toBe('');
        } finally {
            rmSync(memoryDir, { recursive: true, force: true });
            await app.close();
        }
    });

    it('rejects an unsafe node id and a non-string content', async () => {
        const { app } = buildApp();
        try {
            const traversal = await inject(app, {
                method: 'GET',
                url: `/api/memory-file/${encodeURIComponent('../escape')}`,
            });
            expect(traversal.statusCode).toBe(400);

            const badBody = await inject(app, {
                method: 'PUT',
                url: '/api/memory-file/mem-md',
                payload: { content: 99 },
            });
            expect(badBody.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });
});
