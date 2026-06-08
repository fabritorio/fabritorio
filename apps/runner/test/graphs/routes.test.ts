import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { inject } from '../helpers/inject.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor timed out');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
}

function newL2Body(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'demo',
        nodes: [
            {
                id: 'ch',
                type: 'channel',
                channel_kind: 'webchat',
                position: { x: 0, y: 0 },
            },
            {
                id: 'ag',
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 100, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-out',
                source: { node_id: 'ch', port_id: 'out' },
                target: { node_id: 'ag', port_id: 'in' },
            },
        ],
    };
}

describe('graph routes', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-routes-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('CRUD round-trip for a tool-pack graph', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'toolpack',
                    name: 'fs-pack',
                    nodes: [
                        {
                            id: 'tool-1',
                            type: 'tool',
                            tool_name: 'read_file',
                            position: { x: 0, y: 0 },
                        },
                        {
                            id: 'tool-2',
                            type: 'tool',
                            tool_name: 'list_directory',
                            position: { x: 0, y: 80 },
                        },
                    ],
                    edges: [],
                },
            });
            expect(create.statusCode).toBe(201);
            const created = create.json() as { graph: Graph };
            expect(created.graph.kind).toBe('toolpack');

            const list = await inject(app, {
                method: 'GET',
                url: '/api/graphs?kind=toolpack',
            });
            expect(list.statusCode).toBe(200);
            const listed = (list.json() as { graphs: Graph[] }).graphs;
            expect(listed.map((g) => g.id)).toContain(created.graph.id);
            expect(listed.every((g) => g.kind === 'toolpack')).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('CRUD round-trip via /graphs', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL2Body(),
            });
            expect(create.statusCode).toBe(201);
            const created = create.json() as { graph: Graph };
            expect(created.graph.kind).toBe('l2');
            expect(created.graph.id).toMatch(/^[0-9a-f-]{36}$/);

            const list = await inject(app, { method: 'GET', url: '/api/graphs' });
            expect(list.statusCode).toBe(200);
            const listBody = list.json() as { graphs: Graph[] };
            expect(listBody.graphs.map((g) => g.id)).toContain(created.graph.id);

            const del = await inject(app, {
                method: 'DELETE',
                url: `/api/graphs/${created.graph.id}`,
            });
            expect(del.statusCode).toBe(204);
        } finally {
            await app.close();
        }
    });

    it('PATCH renames a graph and preserves library/fragment flags', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const seeded = await graphStore.create({
                ...newL2Body(),
                name: 'old name',
                library: true,
                fragment: true,
            });
            const patch = await inject(app, {
                method: 'PATCH',
                url: `/api/graphs/${seeded.id}`,
                payload: { name: 'new name' },
            });
            expect(patch.statusCode).toBe(200);
            const updated = (patch.json() as { graph: Graph }).graph;
            expect(updated.name).toBe('new name');
            expect(updated.library).toBe(true);
            expect(updated.fragment).toBe(true);

            const got = await graphStore.get(seeded.id!);
            expect(got?.name).toBe('new name');
            expect(got?.fragment).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('PATCH and DELETE refuse a runner-owned system graph (403)', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const seeded = await graphStore.create({ ...newL2Body(), system: true });

            const patch = await inject(app, {
                method: 'PATCH',
                url: `/api/graphs/${seeded.id}`,
                payload: { name: 'nope' },
            });
            expect(patch.statusCode).toBe(403);

            const del = await inject(app, { method: 'DELETE', url: `/api/graphs/${seeded.id}` });
            expect(del.statusCode).toBe(403);

            const got = await graphStore.get(seeded.id!);
            expect(got?.name).toBe('demo');
        } finally {
            await app.close();
        }
    });

    it('PATCH returns 404 for an unknown graph', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const patch = await inject(app, {
                method: 'PATCH',
                url: '/api/graphs/00000000-0000-4000-8000-000000000000',
                payload: { name: 'x' },
            });
            expect(patch.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('load activates source bindings; introspect reports lock + subscriptions', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });

        nodes.register('channel', {
            activate: () => ({ deactivate: () => undefined }),
        });
        nodes.register('native_agent', {
            receiver: () => () => undefined,
        });

        const app = buildServer({
            logger: false,
            graphStore,
            bus,
            runtimes,
            nodes,
        });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL2Body(),
            });
            const id = (create.json() as { graph: Graph }).graph.id!;

            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${id}/load`,
            });
            expect(load.statusCode).toBe(200);
            const loadBody = load.json() as {
                status: string;
                sources: string[];
                subscriptions: string[];
            };
            expect(loadBody.status).toBe('running');
            expect(loadBody.sources).toEqual(['ch']);
            expect(loadBody.subscriptions).toEqual(['e-out']);

            const intro = await inject(app, {
                method: 'GET',
                url: `/api/graphs/${id}/introspect`,
            });
            expect(intro.statusCode).toBe(200);
            expect((intro.json() as { status: string }).status).toBe('running');

            const unload = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${id}/unload`,
            });
            expect(unload.statusCode).toBe(200);
            expect((unload.json() as { status: string }).status).toBe('idle');

            const introAfter = await inject(app, {
                method: 'GET',
                url: `/api/graphs/${id}/introspect`,
            });
            expect(introAfter.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('PUT skips reload for cosmetic edits (rename, position drift)', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        let activations = 0;
        nodes.register('channel', {
            activate: () => {
                activations++;
                return { deactivate: () => undefined };
            },
        });
        nodes.register('native_agent', {
            receiver: () => () => undefined,
        });

        const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL2Body(),
            });
            const id = (create.json() as { graph: Graph }).graph.id!;

            const load = await inject(app, { method: 'POST', url: `/api/graphs/${id}/load` });
            expect(load.statusCode).toBe(200);
            expect(activations).toBe(1);

            const dragged = newL2Body();
            dragged.nodes[0]!.position = { x: 999, y: 42 };
            const renamed = { ...dragged, name: 'renamed' };
            const put = await inject(app, {
                method: 'PUT',
                url: `/api/graphs/${id}`,
                payload: renamed,
            });
            expect(put.statusCode).toBe(200);
            expect((put.json() as { graph: Graph }).graph.name).toBe('renamed');
            expect(activations).toBe(1);
        } finally {
            await app.close();
        }
    });

    it('PUT rebinds a loaded graph when topology changes (e.g. wire a Memory)', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        let channelActivations = 0;
        let memoryActivations = 0;
        nodes.register('channel', {
            activate: () => {
                channelActivations++;
                return { deactivate: () => undefined };
            },
        });
        nodes.register('native_agent', {
            receiver: () => () => undefined,
        });
        nodes.register('memory', {
            activate: () => {
                memoryActivations++;
                return { deactivate: () => undefined };
            },
        });

        const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL2Body(),
            });
            const id = (create.json() as { graph: Graph }).graph.id!;

            await inject(app, { method: 'POST', url: `/api/graphs/${id}/load` });
            expect(channelActivations).toBe(1);
            expect(memoryActivations).toBe(0);

            const withMemory = newL2Body();
            withMemory.nodes.push({
                id: 'mem',
                type: 'memory',
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'full_history',
                tool_access: 'none',
                position: { x: 200, y: 200 },
            });
            withMemory.edges.push({
                id: 'mem->ag',
                source: { node_id: 'mem' },
                target: { node_id: 'ag' },
            });
            const put = await inject(app, {
                method: 'PUT',
                url: `/api/graphs/${id}`,
                payload: withMemory,
            });
            expect(put.statusCode).toBe(200);

            expect(channelActivations).toBe(2);
            expect(memoryActivations).toBe(1);
            const intro = await inject(app, {
                method: 'GET',
                url: `/api/graphs/${id}/introspect`,
            });
            expect(intro.statusCode).toBe(200);
            expect((intro.json() as { sources: string[] }).sources).toContain('mem');
        } finally {
            await app.close();
        }
    });

    it('PUT on a referenced L1 reloads the loaded L2 (idle case)', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: (id) => graphStore.get(id),
        });

        let agentActivations = 0;
        nodes.register('channel', {
            activate: () => ({ deactivate: () => undefined }),
        });
        nodes.register('native_agent', {
            activate: () => {
                agentActivations++;
                return { deactivate: () => undefined };
            },
            receiver: () => () => undefined,
            dependencies: (ctx) => [(ctx.node as { l1_graph_id: string }).l1_graph_id],
        });

        const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });
        try {
            const l1Create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: { kind: 'l1', name: 'brain', nodes: [], edges: [] },
            });
            const l1Id = (l1Create.json() as { graph: Graph }).graph.id!;

            const l2Body = newL2Body();
            (l2Body.nodes[1] as { l1_graph_id: string }).l1_graph_id = l1Id;
            const l2Create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: l2Body,
            });
            const l2Id = (l2Create.json() as { graph: Graph }).graph.id!;

            await inject(app, { method: 'POST', url: `/api/graphs/${l2Id}/load` });
            expect(agentActivations).toBe(1);

            const updatedL1 = {
                kind: 'l1',
                name: 'brain',
                nodes: [
                    {
                        id: 't',
                        type: 'tool',
                        tool_name: 'read_file',
                        position: { x: 0, y: 0 },
                    },
                ],
                edges: [],
            };
            const put = await inject(app, {
                method: 'PUT',
                url: `/api/graphs/${l1Id}`,
                payload: updatedL1,
            });
            expect(put.statusCode).toBe(200);

            expect(agentActivations).toBe(2);
        } finally {
            await app.close();
        }
    });

    it('PUT on a referenced L1 defers reload while a Dispatch is in flight', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: (id) => graphStore.get(id),
        });

        let agentActivations = 0;
        let releaseAgent: () => void = () => undefined;
        let notifyEntered: () => void = () => undefined;
        const enteredPromise = new Promise<void>((resolve) => {
            notifyEntered = resolve;
        });

        nodes.register('channel', {
            activate: () => ({ deactivate: () => undefined }),
        });
        nodes.register('native_agent', {
            activate: () => {
                agentActivations++;
                return { deactivate: () => undefined };
            },
            receiver: () => async () => {
                notifyEntered();
                await new Promise<void>((resolve) => {
                    releaseAgent = resolve;
                });
            },
            dependencies: (ctx) => [(ctx.node as { l1_graph_id: string }).l1_graph_id],
        });

        const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });
        try {
            const l1Create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: { kind: 'l1', name: 'brain', nodes: [], edges: [] },
            });
            const l1Id = (l1Create.json() as { graph: Graph }).graph.id!;

            const l2Body = newL2Body();
            (l2Body.nodes[1] as { l1_graph_id: string }).l1_graph_id = l1Id;
            const l2Create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: l2Body,
            });
            const l2Id = (l2Create.json() as { graph: Graph }).graph.id!;

            await inject(app, { method: 'POST', url: `/api/graphs/${l2Id}/load` });
            expect(agentActivations).toBe(1);

            const dispatchPromise = bus.publish('e-out', {
                eventId: 'test-dispatch',
                source: 'test',
                timestamp: Date.now(),
                messages: [{ role: 'user', content: 'hi' }],
            });
            await enteredPromise;

            const updatedL1 = {
                kind: 'l1',
                name: 'brain',
                nodes: [
                    {
                        id: 't',
                        type: 'tool',
                        tool_name: 'read_file',
                        position: { x: 0, y: 0 },
                    },
                ],
                edges: [],
            };
            const put = await inject(app, {
                method: 'PUT',
                url: `/api/graphs/${l1Id}`,
                payload: updatedL1,
            });
            expect(put.statusCode).toBe(200);
            expect(agentActivations).toBe(1);

            releaseAgent();
            await dispatchPromise;
            await waitFor(() => agentActivations === 2);
            expect(agentActivations).toBe(2);
        } finally {
            await app.close();
        }
    });

    it('DELETE auto-unloads a loaded graph', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        let deactivated = false;
        nodes.register('channel', {
            activate: () => ({
                deactivate: () => {
                    deactivated = true;
                },
            }),
        });
        nodes.register('native_agent', {
            receiver: () => () => undefined,
        });

        const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL2Body(),
            });
            const id = (create.json() as { graph: Graph }).graph.id!;
            await inject(app, { method: 'POST', url: `/api/graphs/${id}/load` });

            const del = await inject(app, { method: 'DELETE', url: `/api/graphs/${id}` });
            expect(del.statusCode).toBe(204);
            expect(deactivated).toBe(true);
            expect(runtimes.get(id)).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it('parent-context returns wired L2 nodes/edges around the parent NativeAgent (Step 8)', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const l1Create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: { kind: 'l1', name: 'brain', nodes: [], edges: [] },
            });
            expect(l1Create.statusCode).toBe(201);
            const l1Id = (l1Create.json() as { graph: Graph }).graph.id!;

            const detached = await inject(app, {
                method: 'GET',
                url: `/api/graphs/${l1Id}/parent-context`,
            });
            expect(detached.statusCode).toBe(200);
            const detachedBody = detached.json() as {
                parentGraphId: string | null;
                nodes: Array<{ id: string }>;
                edges: Array<{ id: string }>;
            };
            expect(detachedBody.parentGraphId).toBeNull();
            expect(detachedBody.nodes).toEqual([]);
            expect(detachedBody.edges).toEqual([]);

            const l2Body: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
                kind: 'l2',
                name: 'demo',
                nodes: [
                    {
                        id: 'ch',
                        type: 'channel',
                        channel_kind: 'webchat',
                        position: { x: 0, y: 0 },
                    },
                    {
                        id: 'mem',
                        type: 'memory',
                        storage: 'in_memory',
                        storage_kind: 'kv',
                        handling: 'full_history',
                        tool_access: 'none',
                        position: { x: 0, y: 100 },
                    },
                    {
                        id: 'ag',
                        type: 'native_agent',
                        l1_graph_id: l1Id,
                        position: { x: 200, y: 0 },
                    },
                    {
                        id: 'loose',
                        type: 'memory',
                        storage: 'in_memory',
                        storage_kind: 'kv',
                        handling: 'full_history',
                        tool_access: 'none',
                        position: { x: 0, y: 300 },
                    },
                ],
                edges: [
                    {
                        id: 'ch->ag',
                        source: { node_id: 'ch' },
                        target: { node_id: 'ag' },
                    },
                    {
                        id: 'mem->ag',
                        source: { node_id: 'mem' },
                        target: { node_id: 'ag' },
                    },
                ],
            };
            const l2Create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: l2Body,
            });
            expect(l2Create.statusCode).toBe(201);
            const l2Id = (l2Create.json() as { graph: Graph }).graph.id!;

            const wired = await inject(app, {
                method: 'GET',
                url: `/api/graphs/${l1Id}/parent-context`,
            });
            expect(wired.statusCode).toBe(200);
            const body = wired.json() as {
                parentGraphId: string | null;
                parentAgentNodeId: string | null;
                nodes: Array<{ id: string; type: string }>;
                edges: Array<{ id: string }>;
            };
            expect(body.parentGraphId).toBe(l2Id);
            expect(body.parentAgentNodeId).toBe('ag');
            const ids = body.nodes.map((n) => n.id).sort();
            expect(ids).toEqual(['ch', 'mem']);
            const edgeIds = body.edges.map((e) => e.id).sort();
            expect(edgeIds).toEqual(['ch->ag', 'mem->ag']);
        } finally {
            await app.close();
        }
    });

    it('rejects malformed bodies with 400', async () => {
        const app = buildServer({
            logger: false,
            graphStore: createGraphStore({ dir }),
        });
        try {
            const res = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: { kind: 'agent', nodes: [], edges: [] },
            });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('clone-subtree applies the fragment into the destination, persists, and deep-copies refs', async () => {
        const graphStore = createGraphStore({ dir });
        const innerL1 = await graphStore.create({
            kind: 'l1',
            nodes: [{ id: 'gw', type: 'gateway', position: { x: 0, y: 0 } }],
            edges: [],
        });
        const destination = await graphStore.create({
            kind: 'l2',
            nodes: [],
            edges: [],
        });

        const app = buildServer({ logger: false, graphStore });
        try {
            const fragment = {
                nodes: [
                    {
                        id: 'ch-1',
                        type: 'channel',
                        channel_kind: 'webchat',
                        position: { x: 0, y: 0 },
                    },
                    {
                        id: 'ag-1',
                        type: 'native_agent',
                        l1_graph_id: innerL1.id,
                        position: { x: 100, y: 0 },
                    },
                ],
                edges: [
                    {
                        id: 'e-out',
                        source: { node_id: 'ch-1', port_id: 'out' },
                        target: { node_id: 'ag-1', port_id: 'in' },
                    },
                ],
            };

            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${destination.id}/clone-subtree`,
                payload: fragment,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
                graph: Graph;
                remap: Record<string, string>;
            };

            expect(body.graph.id).toBe(destination.id);

            const nodeIds = body.graph.nodes.map((n) => n.id);
            expect(nodeIds).not.toContain('ch-1');
            expect(nodeIds).not.toContain('ag-1');
            expect(body.graph.edges.map((e) => e.id)).not.toContain('e-out');

            expect(body.remap['ch-1']).toBeDefined();
            expect(body.remap['ag-1']).toBeDefined();
            expect(body.remap['e-out']).toBeDefined();
            expect(nodeIds).toContain(body.remap['ag-1']);
            expect(nodeIds).toContain(body.remap['ch-1']);

            const pastedAgent = body.graph.nodes.find((n) => n.type === 'native_agent');
            expect(pastedAgent).toBeDefined();
            expect((pastedAgent as { l1_graph_id?: string }).l1_graph_id).toBeDefined();
            expect((pastedAgent as { l1_graph_id?: string }).l1_graph_id).not.toBe(innerL1.id);

            const persisted = await graphStore.get(destination.id);
            expect(persisted!.nodes.some((n) => n.type === 'native_agent')).toBe(true);
            expect(persisted!.nodes.map((n) => n.id)).toContain(body.remap['ag-1']);

            const innerCopyId = (pastedAgent as { l1_graph_id?: string }).l1_graph_id!;
            const reread = await graphStore.get(innerCopyId);
            expect(reread?.kind).toBe('l1');
        } finally {
            await app.close();
        }
    });

    it('clone-subtree reloads the runtime so a pasted agent is queryable immediately', async () => {
        const graphStore = createGraphStore({ dir });
        const innerL1 = await graphStore.create({
            kind: 'l1',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'out', type: 'output', position: { x: 200, y: 0 } },
            ],
            edges: [],
        });
        const destination = await graphStore.create({ kind: 'l2', nodes: [], edges: [] });

        const app = buildServer({ logger: false, graphStore });
        try {
            await inject(app, { method: 'POST', url: `/api/graphs/${destination.id}/load` });

            const fragment = {
                nodes: [
                    {
                        id: 'ag-1',
                        type: 'native_agent',
                        l1_graph_id: innerL1.id,
                        position: { x: 100, y: 0 },
                    },
                ],
                edges: [],
            };
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${destination.id}/clone-subtree`,
                payload: fragment,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { graph: Graph; remap: Record<string, string> };
            const pastedAgentId = body.remap['ag-1']!;

            const convs = await inject(app, {
                method: 'GET',
                url: `/api/agents/${destination.id}/${pastedAgentId}/conversations`,
            });
            expect(convs.statusCode).toBe(200);
            const convsBody = convs.json() as { conversations: unknown[] };
            expect(Array.isArray(convsBody.conversations)).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('clone-subtree 404s when the destination graph does not exist', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/11111111-1111-4111-8111-111111111111/clone-subtree`,
                payload: { nodes: [], edges: [] },
            });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('POST /graphs stamps node-kind defaults onto bare payload nodes', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l1',
                    name: 'bare',
                    nodes: [
                        { type: 'gateway', position: { x: 0, y: 0 } },
                        { type: 'handler', position: { x: 100, y: 0 } },
                        {
                            type: 'model',
                            position: { x: 200, y: 0 },
                            provider: 'openai',
                            model_id: 'gpt-4o-mini',
                        },
                        { type: 'output', position: { x: 300, y: 0 } },
                    ],
                    edges: [],
                },
            });
            expect(create.statusCode).toBe(201);
            const created = (create.json() as { graph: Graph }).graph;
            const handler = created.nodes.find((n) => n.type === 'handler');
            const model = created.nodes.find((n) => n.type === 'model');
            expect((handler as { max_iterations?: number }).max_iterations).toBe(8);
            expect((model as { temperature?: number }).temperature).toBe(0.3);
        } finally {
            await app.close();
        }
    });

    it('PUT /graphs/:id stamps defaults onto bare memory nodes added in an edit', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: newL2Body(),
            });
            const id = (create.json() as { graph: Graph }).graph.id!;
            const withMemory = newL2Body();
            withMemory.nodes.push({
                type: 'memory',
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'last_n',
                tool_access: 'none',
                position: { x: 200, y: 200 },
            } as unknown as Graph['nodes'][number]);
            const put = await inject(app, {
                method: 'PUT',
                url: `/api/graphs/${id}`,
                payload: withMemory,
            });
            expect(put.statusCode).toBe(200);
            const updated = (put.json() as { graph: Graph }).graph;
            const mem = updated.nodes.find((n) => n.type === 'memory');
            expect((mem as { n?: number }).n).toBe(20);
        } finally {
            await app.close();
        }
    });

    it('clone-subtree rejects payloads missing nodes/edges arrays with 400', async () => {
        const graphStore = createGraphStore({ dir });
        const destination = await graphStore.create({ kind: 'l1', nodes: [], edges: [] });
        const app = buildServer({ logger: false, graphStore });
        try {
            const res = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${destination.id}/clone-subtree`,
                payload: { nodes: 'nope' },
            });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('save-fragment freezes a NativeAgent ref into a new library:true subtree', async () => {
        const graphStore = createGraphStore({ dir });
        const liveL1 = await graphStore.create({
            kind: 'l1',
            nodes: [{ id: 'gw', type: 'gateway', position: { x: 0, y: 0 } }],
            edges: [],
        });

        const app = buildServer({ logger: false, graphStore });
        try {
            const res = await inject(app, {
                method: 'POST',
                url: '/api/graphs/save-fragment',
                payload: {
                    kind: 'l2',
                    name: 'my-preset',
                    nodes: [
                        {
                            id: 'ch-1',
                            type: 'channel',
                            channel_kind: 'webchat',
                            position: { x: 0, y: 0 },
                        },
                        {
                            id: 'ag-1',
                            type: 'native_agent',
                            l1_graph_id: liveL1.id,
                            position: { x: 100, y: 0 },
                        },
                    ],
                    edges: [
                        {
                            id: 'e-out',
                            source: { node_id: 'ch-1', port_id: 'out' },
                            target: { node_id: 'ag-1', port_id: 'in' },
                        },
                    ],
                },
            });
            expect(res.statusCode).toBe(201);
            const { graph } = res.json() as { graph: Graph };

            expect(graph.library).toBe(true);
            expect(graph.fragment).toBe(true);
            expect(graph.kind).toBe('l2');
            expect(graph.name).toBe('my-preset');

            const savedAgent = graph.nodes.find((n) => n.type === 'native_agent') as {
                l1_graph_id?: string;
            };
            expect(savedAgent.l1_graph_id).toBeDefined();
            expect(savedAgent.l1_graph_id).not.toBe(liveL1.id);
            const frozen = await graphStore.get(savedAgent.l1_graph_id!);
            expect(frozen?.kind).toBe('l1');
            expect(frozen?.library).toBe(true);

            const reread = await graphStore.get(liveL1.id!);
            expect(reread?.library).not.toBe(true);
        } finally {
            await app.close();
        }
    });

    it('save-fragment rejects a missing name with 400', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const res = await inject(app, {
                method: 'POST',
                url: '/api/graphs/save-fragment',
                payload: { kind: 'l2', nodes: [], edges: [] },
            });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });
});
