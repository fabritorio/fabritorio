import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphStore } from '../../src/graphs/store.js';
import { migrateAgentSidecars, migrateDuplicateRefs } from '../../src/graphs/migrate.js';

describe('migrateDuplicateRefs (Step 4)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-migrate-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('is a no-op on a clean store', async () => {
        const store = createGraphStore({ dir });
        const handler = await store.create({
            kind: 'handler',
            nodes: [],
            edges: [],
        });
        await store.create({
            kind: 'l1',
            nodes: [
                {
                    id: 'h',
                    type: 'handler',
                    position: { x: 0, y: 0 },
                    ref_id: handler.id!,
                },
            ],
            edges: [],
        });

        const summary = await migrateDuplicateRefs(store);
        expect(summary.graphsCopied).toBe(0);
        expect(summary.graphsRewritten).toBe(0);
        expect(summary.passes).toBe(0);
    });

    it('splits a non-library handler shared by two L1s', async () => {
        const store = createGraphStore({ dir });
        const handler = await store.create({
            kind: 'handler',
            nodes: [
                { id: 'in', type: 'handler_input', position: { x: 0, y: 0 } },
                { id: 'out', type: 'handler_output', position: { x: 0, y: 0 } },
            ],
            edges: [],
        });
        const l1a = await store.create({
            kind: 'l1',
            nodes: [
                {
                    id: 'h',
                    type: 'handler',
                    position: { x: 0, y: 0 },
                    ref_id: handler.id!,
                },
            ],
            edges: [],
        });
        const l1b = await store.create({
            kind: 'l1',
            nodes: [
                {
                    id: 'h',
                    type: 'handler',
                    position: { x: 0, y: 0 },
                    ref_id: handler.id!,
                },
            ],
            edges: [],
        });

        const summary = await migrateDuplicateRefs(store);
        expect(summary.graphsCopied).toBe(1);
        expect(summary.graphsRewritten).toBe(1);

        const refs = await collectHandlerRefs(store, [l1a.id!, l1b.id!]);
        expect(refs).toHaveLength(2);
        expect(new Set(refs).size).toBe(2);
        expect(refs).toContain(handler.id);

        const second = await migrateDuplicateRefs(store);
        expect(second.graphsCopied).toBe(0);
    });

    it('copies for ALL referrers when the target is a library template', async () => {
        const store = createGraphStore({ dir });
        const tmpl = await store.create({
            kind: 'handler',
            library: true,
            nodes: [{ id: 'in', type: 'handler_input', position: { x: 0, y: 0 } }],
            edges: [],
        });
        const l1a = await store.create({
            kind: 'l1',
            nodes: [
                {
                    id: 'h',
                    type: 'handler',
                    position: { x: 0, y: 0 },
                    ref_id: tmpl.id!,
                },
            ],
            edges: [],
        });
        const l1b = await store.create({
            kind: 'l1',
            nodes: [
                {
                    id: 'h',
                    type: 'handler',
                    position: { x: 0, y: 0 },
                    ref_id: tmpl.id!,
                },
            ],
            edges: [],
        });

        const summary = await migrateDuplicateRefs(store);
        expect(summary.graphsCopied).toBe(2);

        const refs = await collectHandlerRefs(store, [l1a.id!, l1b.id!]);
        expect(refs).toHaveLength(2);
        expect(refs).not.toContain(tmpl.id);
        expect(new Set(refs).size).toBe(2);

        const reread = await store.get(tmpl.id!);
        expect(reread?.library).toBe(true);
    });

    it('dedupes a NativeAgent.l1_graph_id shared by two L2s', async () => {
        const store = createGraphStore({ dir });
        const l1 = await store.create({
            kind: 'l1',
            nodes: [{ id: 'g', type: 'gateway', position: { x: 0, y: 0 } }],
            edges: [],
        });
        const l2a = await store.create({
            kind: 'l2',
            nodes: [
                {
                    id: 'na',
                    type: 'native_agent',
                    position: { x: 0, y: 0 },
                    l1_graph_id: l1.id!,
                },
            ],
            edges: [],
        });
        const l2b = await store.create({
            kind: 'l2',
            nodes: [
                {
                    id: 'na',
                    type: 'native_agent',
                    position: { x: 0, y: 0 },
                    l1_graph_id: l1.id!,
                },
            ],
            edges: [],
        });

        const summary = await migrateDuplicateRefs(store);
        expect(summary.graphsCopied).toBe(1);

        const a = (await store.get(l2a.id!))!.nodes[0] as {
            l1_graph_id: string;
        };
        const b = (await store.get(l2b.id!))!.nodes[0] as {
            l1_graph_id: string;
        };
        expect(a.l1_graph_id).not.toBe(b.l1_graph_id);
        expect([a.l1_graph_id, b.l1_graph_id]).toContain(l1.id);
    });

    it('converges on transitively-duplicated nested refs', async () => {
        const store = createGraphStore({ dir });
        const tp = await store.create({
            kind: 'toolpack',
            nodes: [],
            edges: [],
        });
        const l1 = await store.create({
            kind: 'l1',
            nodes: [
                {
                    id: 'tp',
                    type: 'tool_pack',
                    position: { x: 0, y: 0 },
                    ref_id: tp.id!,
                },
            ],
            edges: [],
        });
        await store.create({
            kind: 'l2',
            nodes: [
                {
                    id: 'na',
                    type: 'native_agent',
                    position: { x: 0, y: 0 },
                    l1_graph_id: l1.id!,
                },
            ],
            edges: [],
        });
        await store.create({
            kind: 'l2',
            nodes: [
                {
                    id: 'na',
                    type: 'native_agent',
                    position: { x: 0, y: 0 },
                    l1_graph_id: l1.id!,
                },
            ],
            edges: [],
        });

        const summary = await migrateDuplicateRefs(store);
        expect(summary.graphsCopied).toBe(2);
        expect(summary.passes).toBeGreaterThanOrEqual(2);

        const all = await store.list();
        const refCounts = new Map<string, number>();
        for (const g of all) {
            for (const n of g.nodes) {
                if (n.type === 'native_agent' && n.l1_graph_id) {
                    refCounts.set(n.l1_graph_id, (refCounts.get(n.l1_graph_id) ?? 0) + 1);
                }
                if ('ref_id' in n && typeof n.ref_id === 'string') {
                    refCounts.set(n.ref_id, (refCounts.get(n.ref_id) ?? 0) + 1);
                }
            }
        }
        for (const [, count] of refCounts) {
            expect(count).toBeLessThanOrEqual(1);
        }
    });
});

describe('migrateAgentSidecars (B5 backfill)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-sidecar-backfill-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('backfills a sidecar for an agent that lacks one', async () => {
        const store = createGraphStore({ dir });
        const l2 = await store.create({
            kind: 'l2',
            nodes: [{ id: 'na', type: 'native_agent', position: { x: 0, y: 0 } }],
            edges: [],
        });

        const summary = await migrateAgentSidecars(store);
        expect(summary.graphsBackfilled).toBe(1);
        expect(summary.sidecarsMinted).toBe(1);

        const reread = (await store.get(l2.id!))!;
        const channels = reread.nodes.filter((n) => n.type === 'channel');
        expect(channels).toHaveLength(1);
        expect(channels[0]!.type === 'channel' && channels[0]!.owner_node_id).toBe('na');
        expect(reread.edges).toHaveLength(2);
    });

    it('is idempotent — running twice mints exactly one sidecar per agent', async () => {
        const store = createGraphStore({ dir });
        const l2 = await store.create({
            kind: 'l2',
            nodes: [{ id: 'na', type: 'native_agent', position: { x: 0, y: 0 } }],
            edges: [],
        });

        const first = await migrateAgentSidecars(store);
        expect(first.sidecarsMinted).toBe(1);
        const second = await migrateAgentSidecars(store);
        expect(second.graphsBackfilled).toBe(0);
        expect(second.sidecarsMinted).toBe(0);

        const reread = (await store.get(l2.id!))!;
        expect(reread.nodes.filter((n) => n.type === 'channel')).toHaveLength(1);
    });

    it('does not double-mint when the agent already owns a channel, and leaves user-placed channels alone', async () => {
        const store = createGraphStore({ dir });
        const l2 = await store.create({
            kind: 'l2',
            nodes: [
                {
                    id: 'user-ch',
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                { id: 'na', type: 'native_agent', position: { x: 100, y: 0 } },
                {
                    id: 'owned-ch',
                    type: 'channel',
                    channel_kind: 'webchat',
                    owner_node_id: 'na',
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [],
        });

        const summary = await migrateAgentSidecars(store);
        expect(summary.graphsBackfilled).toBe(0);
        expect(summary.sidecarsMinted).toBe(0);

        const reread = (await store.get(l2.id!))!;
        const channels = reread.nodes.filter((n) => n.type === 'channel');
        expect(channels.map((c) => c.id).sort()).toEqual(['owned-ch', 'user-ch']);
        const userCh = channels.find((c) => c.id === 'user-ch')!;
        expect(userCh.type === 'channel' && userCh.owner_node_id).toBeFalsy();
    });

    it('preserves library/system flags on a backfilled template', async () => {
        const store = createGraphStore({ dir });
        const l2 = await store.create({
            kind: 'l2',
            library: true,
            system: true,
            nodes: [{ id: 'na', type: 'native_agent', position: { x: 0, y: 0 } }],
            edges: [],
        });

        await migrateAgentSidecars(store);
        const reread = (await store.get(l2.id!))!;
        expect(reread.library).toBe(true);
        expect(reread.system).toBe(true);
        expect(reread.nodes.filter((n) => n.type === 'channel')).toHaveLength(1);
    });
});

async function collectHandlerRefs(
    store: ReturnType<typeof createGraphStore>,
    ids: readonly string[],
): Promise<string[]> {
    const out: string[] = [];
    for (const id of ids) {
        const g = await store.get(id);
        if (!g) continue;
        for (const n of g.nodes) {
            if (n.type === 'handler' && n.ref_id) out.push(n.ref_id);
        }
    }
    return out;
}
