import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STARTER_L1_ID, STARTER_SKILLPACK_ID, STARTER_TOOLPACK_ID } from '@fabritorio/types';
import { createGraphStore } from '../../src/graphs/store.js';
import { mintMissingRefs } from '../../src/graphs/mint-on-add.js';
import { seedStarterLibraryGraphs } from '../../src/runtime/handlers/starter-seeds.js';
import type { Op } from '../../src/graphs/ops.js';

describe('mintMissingRefs', () => {
    let dir: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-mint-'));
        await seedStarterLibraryGraphs(createGraphStore({ dir }));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('mints an L1 for a bare native_agent and sets l1_graph_id', async () => {
        const store = createGraphStore({ dir });
        const ops: Op[] = [{ op: 'add_node', kind: 'native_agent', position: { x: 0, y: 0 } }];
        const { minted } = await mintMissingRefs(store, ops);

        expect(minted).toHaveLength(1);
        const op = ops[0] as Extract<Op, { op: 'add_node' }>;
        const refId = op.config?.l1_graph_id as string;
        expect(refId).toBe(minted[0]);
        const copy = await store.get(refId);
        expect(copy).toBeDefined();
        expect(copy!.kind).toBe('l1');
        expect(copy!.id).not.toBe(STARTER_L1_ID);
        expect(copy!.library).not.toBe(true);
        expect(copy!.system).not.toBe(true);
    });

    it('mints a toolpack for a bare tool_pack and sets ref_id', async () => {
        const store = createGraphStore({ dir });
        const ops: Op[] = [{ op: 'add_node', kind: 'tool_pack', position: { x: 0, y: 0 } }];
        const { minted } = await mintMissingRefs(store, ops);

        const op = ops[0] as Extract<Op, { op: 'add_node' }>;
        const refId = op.config?.ref_id as string;
        expect(refId).toBe(minted[0]);
        const copy = await store.get(refId);
        expect(copy!.kind).toBe('toolpack');
        expect(copy!.id).not.toBe(STARTER_TOOLPACK_ID);
    });

    it('mints a skillpack for a bare skill_pack and sets ref_id', async () => {
        const store = createGraphStore({ dir });
        const ops: Op[] = [{ op: 'add_node', kind: 'skill_pack', position: { x: 0, y: 0 } }];
        const { minted } = await mintMissingRefs(store, ops);

        const op = ops[0] as Extract<Op, { op: 'add_node' }>;
        const refId = op.config?.ref_id as string;
        expect(refId).toBe(minted[0]);
        const copy = await store.get(refId);
        expect(copy!.kind).toBe('skillpack');
        expect(copy!.id).not.toBe(STARTER_SKILLPACK_ID);
    });

    it('leaves an add_node already carrying a ref untouched (paste / library drop)', async () => {
        const store = createGraphStore({ dir });
        const ops: Op[] = [
            {
                op: 'add_node',
                kind: 'tool_pack',
                position: { x: 0, y: 0 },
                config: { ref_id: 'pre-existing-ref' },
            },
        ];
        const { minted } = await mintMissingRefs(store, ops);

        expect(minted).toEqual([]);
        const op = ops[0] as Extract<Op, { op: 'add_node' }>;
        expect(op.config?.ref_id).toBe('pre-existing-ref');
    });

    it('ignores non-ref-bearing kinds and non-add ops', async () => {
        const store = createGraphStore({ dir });
        const ops: Op[] = [
            { op: 'add_node', kind: 'channel', position: { x: 0, y: 0 } },
            { op: 'delete_node', id: 'whatever' },
        ];
        const { minted } = await mintMissingRefs(store, ops);
        expect(minted).toEqual([]);
        const add = ops[0] as Extract<Op, { op: 'add_node' }>;
        expect(add.config?.ref_id).toBeUndefined();
        expect(add.config?.l1_graph_id).toBeUndefined();
    });

    it('mints independently for multiple bare ref-bearing nodes in one batch', async () => {
        const store = createGraphStore({ dir });
        const ops: Op[] = [
            { op: 'add_node', kind: 'tool_pack', position: { x: 0, y: 0 } },
            { op: 'add_node', kind: 'skill_pack', position: { x: 0, y: 0 } },
        ];
        const { minted } = await mintMissingRefs(store, ops);
        expect(minted).toHaveLength(2);
        expect(new Set(minted).size).toBe(2);
    });
});
