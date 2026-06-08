import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { inject } from '../helpers/inject.js';

function emptyL2(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return { kind: 'l2', name: 'orphan-test', nodes: [], edges: [] };
}

async function createGraph(
    app: ReturnType<typeof buildServer>,
    payload: Omit<Graph, 'id' | 'created_at' | 'updated_at'>,
): Promise<string> {
    const res = await inject(app, { method: 'POST', url: '/api/graphs', payload });
    return (res.json() as { graph: Graph }).graph.id!;
}

describe('orphan-subgraph cleanup (routes)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-orphan-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('mint pre-pass: bare native_agent owns a fresh L1 and still mints its sidecar', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            await app.bootstrapComplete;
            const graphId = await createGraph(app, emptyL2());
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [{ op: 'add_node', kind: 'native_agent', position: { x: 0, y: 0 } }],
                },
            });
            expect(res.statusCode).toBe(200);
            const graph = (res.json() as { graph: Graph }).graph;
            const agent = graph.nodes.find((n) => n.type === 'native_agent') as
                | { id: string; l1_graph_id?: string }
                | undefined;
            expect(agent).toBeDefined();
            expect(typeof agent!.l1_graph_id).toBe('string');
            const owned = await graphStore.get(agent!.l1_graph_id!);
            expect(owned?.kind).toBe('l1');
            const sidecar = graph.nodes.find(
                (n) => n.type === 'channel' && n.owner_node_id === agent!.id,
            );
            expect(sidecar).toBeDefined();
        } finally {
            await app.close();
        }
    });

    it('delete_node removes the owned subgraph file', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            await app.bootstrapComplete;
            const graphId = await createGraph(app, emptyL2());
            const l1Id = await createGraph(app, { kind: 'l1', nodes: [], edges: [] });
            const add = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${l1Id}/ops`,
                payload: {
                    ops: [{ op: 'add_node', kind: 'tool_pack', position: { x: 0, y: 0 } }],
                },
            });
            expect(add.statusCode).toBe(200);
            const addBody = add.json() as { graph: Graph };
            const pack = addBody.graph.nodes.find((n) => n.type === 'tool_pack') as {
                id: string;
                ref_id: string;
            };
            const refId = pack.ref_id;
            expect(await graphStore.get(refId)).toBeDefined();

            const del = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${l1Id}/ops`,
                payload: { ops: [{ op: 'delete_node', id: pack.id }] },
            });
            expect(del.statusCode).toBe(200);
            const results = (
                del.json() as { results: Array<{ op: string; orphanedRefId?: string }> }
            ).results;
            expect(results[0]?.orphanedRefId).toBe(refId);
            expect(await graphStore.get(refId)).toBeUndefined();
            void graphId;
        } finally {
            await app.close();
        }
    });

    it('delete_node on a ref-less node is a cleanup no-op', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            await app.bootstrapComplete;
            const l1Id = await createGraph(app, { kind: 'l1', nodes: [], edges: [] });
            const add = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${l1Id}/ops`,
                payload: { ops: [{ op: 'add_node', kind: 'gateway', position: { x: 0, y: 0 } }] },
            });
            const gateway = (add.json() as { graph: Graph }).graph.nodes.find(
                (n) => n.type === 'gateway',
            )!;
            const before = (await graphStore.list()).length;
            const del = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${l1Id}/ops`,
                payload: { ops: [{ op: 'delete_node', id: gateway.id }] },
            });
            expect(del.statusCode).toBe(200);
            const results = (del.json() as { results: Array<{ orphanedRefId?: string | null }> })
                .results;
            expect(results[0]?.orphanedRefId).toBeNull();
            expect((await graphStore.list()).length).toBe(before);
        } finally {
            await app.close();
        }
    });

    it('DELETE /graphs/:id cascades into owned subgraphs (L2 → L1 → toolpack)', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            await app.bootstrapComplete;
            const toolpack = await graphStore.create({ kind: 'toolpack', nodes: [], edges: [] });
            const l1 = await graphStore.create({
                kind: 'l1',
                nodes: [
                    {
                        id: 'handler',
                        type: 'handler',
                        position: { x: 0, y: 0 },
                        ref_id: toolpack.id!,
                    },
                ],
                edges: [],
            });
            const l2 = await graphStore.create({
                kind: 'l2',
                nodes: [
                    {
                        id: 'agent',
                        type: 'native_agent',
                        position: { x: 0, y: 0 },
                        l1_graph_id: l1.id!,
                    },
                ],
                edges: [],
            });

            const del = await inject(app, { method: 'DELETE', url: `/api/graphs/${l2.id}` });
            expect(del.statusCode).toBe(204);
            expect(await graphStore.get(l2.id!)).toBeUndefined();
            expect(await graphStore.get(l1.id!)).toBeUndefined();
            expect(await graphStore.get(toolpack.id!)).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it('rolls back minted subgraphs when the op batch fails to apply', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            await app.bootstrapComplete;
            const graphId = await createGraph(app, emptyL2());
            const before = (await graphStore.list()).length;
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        { op: 'add_node', kind: 'native_agent', position: { x: 0, y: 0 } },
                        { op: 'add_edge', source: '$nope', target: '$also-nope' },
                    ],
                },
            });
            expect(res.statusCode).toBe(400);
            expect((await graphStore.list()).length).toBe(before);
        } finally {
            await app.close();
        }
    });

    it('DELETE /graphs/:id still 404s on a missing id', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            await app.bootstrapComplete;
            const missing = '00000000-0000-4000-8000-0000000000bb';
            const del = await inject(app, { method: 'DELETE', url: `/api/graphs/${missing}` });
            expect(del.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });
});
