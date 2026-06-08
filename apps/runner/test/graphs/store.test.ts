import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryNode } from '@fabritorio/types';
import { createGraphStore } from '../../src/graphs/store.js';

describe('GraphStore', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-graphs-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('create assigns a fresh uuid and persists kind-tagged Graph', async () => {
        const store = createGraphStore({ dir });
        const saved = await store.create({
            kind: 'l1',
            name: 'x',
            nodes: [],
            edges: [],
        });
        expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(saved.kind).toBe('l1');
        const onDisk = JSON.parse(await readFile(join(dir, `${saved.id}.json`), 'utf8'));
        expect(onDisk.kind).toBe('l1');
        expect(onDisk.id).toBe(saved.id);
    });

    it('get returns undefined for unknown ids; list filters by kind', async () => {
        const store = createGraphStore({ dir });
        const a = await store.create({ kind: 'l1', nodes: [], edges: [] });
        const o = await store.create({ kind: 'l2', nodes: [], edges: [] });
        expect(await store.get('not-a-uuid')).toBeUndefined();
        expect((await store.get(a.id!))?.kind).toBe('l1');

        const l1s = await store.list({ kind: 'l1' });
        expect(l1s.map((g) => g.id)).toEqual([a.id]);
        const l2s = await store.list({ kind: 'l2' });
        expect(l2s.map((g) => g.id)).toEqual([o.id]);
        const all = await store.list();
        expect(all.map((g) => g.id).sort()).toEqual([a.id, o.id].sort());
    });

    it('update preserves created_at and bumps updated_at', async () => {
        const store = createGraphStore({ dir });
        const a = await store.create({ kind: 'l1', nodes: [], edges: [] });
        const before = a.updated_at!;
        await new Promise((r) => setTimeout(r, 5));
        const updated = await store.update(a.id!, {
            kind: 'l1',
            name: 'renamed',
            nodes: [],
            edges: [],
        });
        expect(updated?.created_at).toBe(a.created_at);
        expect(updated?.updated_at).not.toBe(before);
        expect(updated?.name).toBe('renamed');
    });

    it('delete returns false for unknown id and true once removed', async () => {
        const store = createGraphStore({ dir });
        const a = await store.create({ kind: 'l1', nodes: [], edges: [] });
        expect(await store.delete('not-a-uuid')).toBe(false);
        expect(await store.delete(a.id!)).toBe(true);
        expect(await store.delete(a.id!)).toBe(false);
    });

    it('migrates legacy `purpose` Memory nodes into the orthogonal triple on read', async () => {
        const store = createGraphStore({ dir });
        const id = randomUUID();
        const onDisk = {
            id,
            kind: 'l2',
            nodes: [
                {
                    id: 'sess',
                    type: 'memory',
                    storage: 'in_memory',
                    position: { x: 0, y: 0 },
                    purpose: 'session',
                },
                {
                    id: 'ctx',
                    type: 'memory',
                    storage: 'in_memory',
                    position: { x: 0, y: 0 },
                    purpose: 'context',
                    content: 'persona',
                },
                {
                    id: 'sp',
                    type: 'memory',
                    storage: 'local_storage',
                    position: { x: 0, y: 0 },
                    purpose: 'scratchpad',
                },
            ],
            edges: [],
        };
        await writeFile(join(dir, `${id}.json`), JSON.stringify(onDisk), 'utf8');

        const loaded = await store.get(id);
        expect(loaded).toBeDefined();
        const [sess, ctx, sp] = loaded!.nodes as MemoryNode[];
        expect(sess.storage_kind).toBe('kv');
        expect(sess.handling).toBe('full_history');
        expect(sess.tool_access).toBe('none');
        expect((sess as { purpose?: unknown }).purpose).toBeUndefined();

        expect(ctx.storage_kind).toBe('static_string');
        expect(ctx.handling).toBe('always_inject');
        expect(ctx.tool_access).toBe('none');
        expect(ctx.content).toBe('persona');

        expect(sp.storage_kind).toBe('markdown');
        expect(sp.handling).toBe('always_inject');
        expect(sp.tool_access).toBe('read_write');
    });
});
