import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph } from '@fabritorio/types';
import { createGraphStore, type GraphStore } from '../../src/graphs/store.js';
import { deleteSubtree } from '../../src/graphs/cascade-delete.js';

async function mkGraph(
    store: GraphStore,
    over: Partial<Omit<Graph, 'id' | 'created_at' | 'updated_at'>> = {},
): Promise<Graph> {
    return store.create({ kind: 'l2', nodes: [], edges: [], ...over });
}

describe('deleteSubtree', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-cascade-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('{ includeRoot: true } deletes the root and the whole nested chain', async () => {
        const store = createGraphStore({ dir });
        const toolpack = await mkGraph(store, { kind: 'toolpack' });
        const l1 = await mkGraph(store, {
            kind: 'l1',
            nodes: [
                {
                    id: 'handler',
                    type: 'handler',
                    position: { x: 0, y: 0 },
                    ref_id: toolpack.id!,
                },
            ],
        });
        const l2 = await mkGraph(store, {
            kind: 'l2',
            nodes: [
                {
                    id: 'agent',
                    type: 'native_agent',
                    position: { x: 0, y: 0 },
                    l1_graph_id: l1.id!,
                },
            ],
        });

        const deleted = await deleteSubtree(store, l2.id!, { includeRoot: true });

        expect(new Set(deleted)).toEqual(new Set([toolpack.id, l1.id, l2.id]));
        expect(await store.get(l2.id!)).toBeUndefined();
        expect(await store.get(l1.id!)).toBeUndefined();
        expect(await store.get(toolpack.id!)).toBeUndefined();
    });

    it('post-order: children are deleted before their parent', async () => {
        const store = createGraphStore({ dir });
        const toolpack = await mkGraph(store, { kind: 'toolpack' });
        const l1 = await mkGraph(store, {
            kind: 'l1',
            nodes: [
                { id: 'handler', type: 'handler', position: { x: 0, y: 0 }, ref_id: toolpack.id! },
            ],
        });
        const deleted = await deleteSubtree(store, l1.id!, { includeRoot: true });
        expect(deleted.indexOf(toolpack.id!)).toBeLessThan(deleted.indexOf(l1.id!));
    });

    it('{ includeRoot: false } keeps the root but removes the owned children', async () => {
        const store = createGraphStore({ dir });
        const toolpack = await mkGraph(store, { kind: 'toolpack' });
        const l1 = await mkGraph(store, {
            kind: 'l1',
            nodes: [
                { id: 'handler', type: 'handler', position: { x: 0, y: 0 }, ref_id: toolpack.id! },
            ],
        });

        const deleted = await deleteSubtree(store, l1.id!, { includeRoot: false });

        expect(deleted).toEqual([toolpack.id]);
        expect(await store.get(l1.id!)).toBeDefined();
        expect(await store.get(toolpack.id!)).toBeUndefined();
    });

    it('soft-skips a dangling ref (no throw)', async () => {
        const store = createGraphStore({ dir });
        const missingId = '00000000-0000-4000-8000-0000000000ff';
        const l1 = await mkGraph(store, {
            kind: 'l1',
            nodes: [
                { id: 'handler', type: 'handler', position: { x: 0, y: 0 }, ref_id: missingId },
            ],
        });

        const deleted = await deleteSubtree(store, l1.id!, { includeRoot: true });
        expect(deleted).toEqual([l1.id]);
    });

    it('terminates on a cyclic ref pair', async () => {
        const store = createGraphStore({ dir });
        const a = await mkGraph(store, { kind: 'l1' });
        const b = await mkGraph(store, { kind: 'l1' });
        await store.update(a.id!, {
            kind: 'l1',
            nodes: [{ id: 'h', type: 'handler', position: { x: 0, y: 0 }, ref_id: b.id! }],
            edges: [],
        });
        await store.update(b.id!, {
            kind: 'l1',
            nodes: [{ id: 'h', type: 'handler', position: { x: 0, y: 0 }, ref_id: a.id! }],
            edges: [],
        });

        const deleted = await deleteSubtree(store, a.id!, { includeRoot: true });
        expect(new Set(deleted)).toEqual(new Set([a.id, b.id]));
        expect(await store.get(a.id!)).toBeUndefined();
        expect(await store.get(b.id!)).toBeUndefined();
    });

    it('missing root returns an empty list (404 signal for the route)', async () => {
        const store = createGraphStore({ dir });
        const missingId = '00000000-0000-4000-8000-0000000000aa';
        const deleted = await deleteSubtree(store, missingId, { includeRoot: true });
        expect(deleted).toEqual([]);
    });
});
