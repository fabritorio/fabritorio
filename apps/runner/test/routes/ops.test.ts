import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { MODEL_PROVIDER_DEFAULT } from '../../src/graphs/defaults.js';
import { inject } from '../helpers/inject.js';

function newL1Graph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l1',
        name: 'ops-test',
        nodes: [
            {
                id: 'gw-1',
                type: 'gateway',
                position: { x: 0, y: 0 },
            },
            {
                id: 'out-1',
                type: 'output',
                position: { x: 300, y: 0 },
            },
        ],
        edges: [],
    };
}

describe('POST /graphs/:id/ops', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-ops-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('add_node mints an id and stamps Phase-3 defaults', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;

            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        {
                            op: 'add_node',
                            kind: 'handler',
                            position: { x: 100, y: 100 },
                            as: '$h',
                        },
                    ],
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
                graph: Graph;
                remap: Record<string, string>;
                results: Array<{ op: string; ok: boolean; node?: { id: string; type: string } }>;
            };
            expect(body.remap.$h).toBeDefined();
            const mintedId = body.remap.$h!;
            const handler = body.graph.nodes.find((n) => n.id === mintedId);
            expect(handler).toBeDefined();
            expect(handler?.type).toBe('handler');
            expect(body.results[0]?.op).toBe('add_node');
            const node = body.results[0]?.node as { type: string; max_iterations?: number };
            expect(node.max_iterations).toBe(8);
        } finally {
            await app.close();
        }
    });

    it('accepts add_node with no config; defaults fill where possible', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            await app.bootstrapComplete;
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        { op: 'add_node', kind: 'tool_pack', position: { x: 0, y: 0 } },
                        { op: 'add_node', kind: 'model', position: { x: 100, y: 0 } },
                    ],
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { graph: Graph };
            const pack = body.graph.nodes.find((n) => n.type === 'tool_pack');
            expect(pack).toBeDefined();
            const refId = (pack as { ref_id?: string }).ref_id;
            expect(typeof refId).toBe('string');
            const owned = await graphStore.get(refId!);
            expect(owned).toBeDefined();
            expect(owned!.kind).toBe('toolpack');
            const model = body.graph.nodes.find((n) => n.type === 'model');
            expect(model).toBeDefined();
            expect((model as { provider?: string }).provider).toBe(MODEL_PROVIDER_DEFAULT);
        } finally {
            await app.close();
        }
    });

    it('add_edge resolves placeholder refs and validates against the palette', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;

            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        { op: 'add_node', kind: 'handler', position: { x: 100, y: 100 }, as: '$h' },
                        {
                            op: 'add_node',
                            kind: 'model',
                            config: {
                                provider: 'openai',
                                model_id: 'gpt-4o-mini',
                                auth_env: 'OPENAI_API_KEY',
                            },
                            position: { x: 200, y: 100 },
                            as: '$m',
                        },
                        { op: 'add_edge', source: '$h', target: '$m' },
                    ],
                },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
                graph: Graph;
                remap: Record<string, string>;
                results: Array<{
                    op: string;
                    ok: boolean;
                    edge?: {
                        id: string;
                        source: { node_id: string; port_id?: string };
                        target: { node_id: string; port_id?: string };
                    };
                }>;
            };
            const hId = body.remap.$h!;
            const mId = body.remap.$m!;
            const edge = body.graph.edges.find(
                (e) => e.source.node_id === hId && e.target.node_id === mId,
            );
            expect(edge).toBeDefined();
            expect(edge?.source.port_id).toBe('model-out');
            expect(edge?.target.port_id).toBe('model-in');
            expect(body.results[2]?.op).toBe('add_edge');
        } finally {
            await app.close();
        }
    });

    it('rejects an illegal wire per the palette connection matrix', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [{ op: 'add_edge', source: 'gw-1', target: 'out-1' }],
                },
            });
            expect(res.statusCode).toBe(400);
            const body = res.json() as { code: string; error: string };
            expect(body.code).toBe('illegal_wire');
        } finally {
            await app.close();
        }
    });

    it('update_node_config merges patch; clearing a required field is permitted', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'toolpack',
                    nodes: [
                        {
                            id: 't',
                            type: 'tool',
                            tool_name: 'read_file',
                            position: { x: 0, y: 0 },
                        },
                    ],
                    edges: [],
                },
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;

            const ok = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        {
                            op: 'update_node_config',
                            id: 't',
                            patch: { tool_name: 'list_directory' },
                        },
                    ],
                },
            });
            expect(ok.statusCode).toBe(200);
            const okBody = ok.json() as { graph: Graph };
            const tool = okBody.graph.nodes.find((n) => n.id === 't');
            expect((tool as { tool_name?: string }).tool_name).toBe('list_directory');

            const cleared = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [{ op: 'update_node_config', id: 't', patch: { tool_name: '' } }],
                },
            });
            expect(cleared.statusCode).toBe(200);
            const clearedBody = cleared.json() as { graph: Graph };
            const clearedTool = clearedBody.graph.nodes.find((n) => n.id === 't');
            expect((clearedTool as { tool_name?: string }).tool_name).toBe('');
        } finally {
            await app.close();
        }
    });

    it('delete_node cascades touching edges', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;

            const setup = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        { op: 'add_node', kind: 'handler', position: { x: 0, y: 0 }, as: '$h' },
                        {
                            op: 'add_node',
                            kind: 'model',
                            config: {
                                provider: 'openai',
                                model_id: 'gpt-4o-mini',
                                auth_env: 'OPENAI_API_KEY',
                            },
                            position: { x: 100, y: 0 },
                            as: '$m',
                        },
                        { op: 'add_edge', source: '$h', target: '$m' },
                    ],
                },
            });
            const setupBody = setup.json() as {
                graph: Graph;
                remap: Record<string, string>;
            };
            const hId = setupBody.remap.$h!;
            const edgeId = setupBody.graph.edges.find((e) => e.source.node_id === hId)!.id;

            const del = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: { ops: [{ op: 'delete_node', id: hId }] },
            });
            expect(del.statusCode).toBe(200);
            const delBody = del.json() as {
                graph: Graph;
                results: Array<{ op: string; ok: boolean; cascadedEdgeIds?: string[] }>;
            };
            expect(delBody.graph.nodes.find((n) => n.id === hId)).toBeUndefined();
            expect(delBody.graph.edges.find((e) => e.id === edgeId)).toBeUndefined();
            expect(delBody.results[0]?.cascadedEdgeIds).toContain(edgeId);
        } finally {
            await app.close();
        }
    });

    it('delete_edge removes one edge without touching nodes', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;

            const setup = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        { op: 'add_node', kind: 'handler', position: { x: 0, y: 0 }, as: '$h' },
                        {
                            op: 'add_node',
                            kind: 'model',
                            config: {
                                provider: 'openai',
                                model_id: 'gpt-4o-mini',
                                auth_env: 'OPENAI_API_KEY',
                            },
                            position: { x: 100, y: 0 },
                            as: '$m',
                        },
                        { op: 'add_edge', source: '$h', target: '$m' },
                    ],
                },
            });
            const setupBody = setup.json() as {
                graph: Graph;
                remap: Record<string, string>;
            };
            const edgeId = setupBody.graph.edges[0]!.id;

            const del = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: { ops: [{ op: 'delete_edge', id: edgeId }] },
            });
            expect(del.statusCode).toBe(200);
            const delBody = del.json() as { graph: Graph };
            expect(delBody.graph.edges.find((e) => e.id === edgeId)).toBeUndefined();
            expect(delBody.graph.nodes.length).toBe(setupBody.graph.nodes.length);
        } finally {
            await app.close();
        }
    });

    it('rejects an unresolvable placeholder reference', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [{ op: 'add_edge', source: '$missing', target: 'out-1' }],
                },
            });
            expect(res.statusCode).toBe(400);
            const body = res.json() as { code: string };
            expect(body.code).toBe('placeholder_unresolved');
        } finally {
            await app.close();
        }
    });

    it('returns 404 for an unknown graph id', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const fakeId = '00000000-0000-4000-8000-000000000000';
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${fakeId}/ops`,
                payload: {
                    ops: [{ op: 'add_node', kind: 'handler', position: { x: 0, y: 0 } }],
                },
            });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('bails on the first failing op and persists nothing from the batch', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL1Graph(),
            });
            const graphId = (create.json() as { graph: Graph }).graph.id!;
            const before = (
                (await inject(app, { method: 'GET', url: `/api/graphs/${graphId}` })).json() as {
                    graph: Graph;
                }
            ).graph;

            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/ops`,
                payload: {
                    ops: [
                        { op: 'add_node', kind: 'handler', position: { x: 0, y: 0 } },
                        { op: 'add_node', kind: 'not_a_real_kind', position: { x: 100, y: 0 } },
                    ],
                },
            });
            expect(res.statusCode).toBe(400);
            const after = (
                (await inject(app, { method: 'GET', url: `/api/graphs/${graphId}` })).json() as {
                    graph: Graph;
                }
            ).graph;
            expect(after.nodes.map((n) => n.id).sort()).toEqual(
                before.nodes.map((n) => n.id).sort(),
            );
        } finally {
            await app.close();
        }
    });

    it('serializes concurrent /ops on a loaded graph (mutex regression)', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l2',
                    name: 'race-test',
                    nodes: [
                        {
                            id: 'ch-1',
                            type: 'channel',
                            position: { x: 0, y: 0 },
                            channel_kind: 'webchat',
                        },
                    ],
                    edges: [],
                } satisfies Omit<Graph, 'id' | 'created_at' | 'updated_at'>,
            });
            expect(create.statusCode).toBe(201);
            const { graph } = create.json() as { graph: Graph };
            const graphId = graph.id!;
            const channelId = graph.nodes.find((n) => n.type === 'channel')!.id;

            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/load`,
                payload: {},
            });
            expect(load.statusCode).toBe(200);

            const N = 8;
            const responses = await Promise.all(
                Array.from({ length: N }, (_, i) =>
                    inject(app, {
                        method: 'POST',
                        url: `/api/graphs/${graphId}/ops`,
                        payload: {
                            ops: [
                                {
                                    op: 'update_node_config',
                                    id: channelId,
                                    patch: { display_name: `Run-${i}` },
                                },
                            ],
                        },
                    }),
                ),
            );
            for (const res of responses) {
                expect(res.statusCode).toBe(200);
            }

            const after = (
                (await inject(app, { method: 'GET', url: `/api/graphs/${graphId}` })).json() as {
                    graph: Graph;
                }
            ).graph;
            expect(after.nodes.map((n) => n.id)).toEqual([channelId]);
            const ch = after.nodes[0] as { display_name?: string };
            expect(ch.display_name).toMatch(/^Run-\d+$/);
        } finally {
            await app.close();
        }
    });
});
