import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphStore } from '../../src/graphs/store.js';
import { cloneGraphTree } from '../../src/graphs/instantiate.js';

describe('cloneGraphTree markLibrary', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-clone-marklib-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('marks the copied tree library:true when the flag is set (root + nested ref)', async () => {
        const store = createGraphStore({ dir });
        const innerL1 = await store.create({
            kind: 'l1',
            nodes: [{ id: 'gw', type: 'gateway', position: { x: 0, y: 0 } }],
            edges: [],
        });
        const source = await store.create({
            kind: 'l2',
            name: 'preset',
            nodes: [
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: innerL1.id,
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        });

        const { copy } = await cloneGraphTree(store, source.id!, { markLibrary: true });
        expect(copy.library).toBe(true);

        const copiedAgent = copy.nodes.find((n) => n.type === 'native_agent') as {
            l1_graph_id?: string;
        };
        expect(copiedAgent.l1_graph_id).toBeDefined();
        expect(copiedAgent.l1_graph_id).not.toBe(innerL1.id);
        const nestedCopy = await store.get(copiedAgent.l1_graph_id!);
        expect(nestedCopy?.library).toBe(true);

        const originalL1 = await store.get(innerL1.id!);
        expect(originalL1?.library).not.toBe(true);
    });

    it('leaves the copied tree non-library by default', async () => {
        const store = createGraphStore({ dir });
        const innerL1 = await store.create({
            kind: 'l1',
            nodes: [{ id: 'gw', type: 'gateway', position: { x: 0, y: 0 } }],
            edges: [],
        });
        const source = await store.create({
            kind: 'l2',
            nodes: [
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: innerL1.id,
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        });

        const { copy } = await cloneGraphTree(store, source.id!);
        expect(copy.library).not.toBe(true);

        const copiedAgent = copy.nodes.find((n) => n.type === 'native_agent') as {
            l1_graph_id?: string;
        };
        const nestedCopy = await store.get(copiedAgent.l1_graph_id!);
        expect(nestedCopy?.library).not.toBe(true);
    });
});
