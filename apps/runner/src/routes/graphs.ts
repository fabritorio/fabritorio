import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Edge, Graph, GraphKind, Node, NodeRuntimeStateWire } from '@fabritorio/types';
import { isValidGraphId, type GraphStore } from '../graphs/store.js';
import {
    cloneGraphTree,
    cloneSubtreeFragment,
    instantiateLibraryGraph,
    rewriteRefsInNode,
} from '../graphs/instantiate.js';
import { withGraphLock } from '../graphs/lock.js';
import { deleteSubtree } from '../graphs/cascade-delete.js';
import { mintMissingRefs } from '../graphs/mint-on-add.js';
import { applyOps, parseOps } from '../graphs/ops.js';
import { refOf } from '../graphs/invariant.js';
import { applyGraphEdit, createGraphPersist, type GraphDraft } from '../graphs/persist.js';
import { findParentNativeAgentForL1 } from '../runtime/agents/wiring.js';
import { graphIsAutonomous, type GraphRuntimeRegistry } from '../runtime/graph-runtime.js';
import type { ConversationLabelStore } from '../runtime/conversation-labels.js';

export interface GraphRoutesDeps {
    graphStore: GraphStore;
    runtimes: GraphRuntimeRegistry;
    conversationLabels: ConversationLabelStore;
}

interface IdParam {
    id: string;
}

const GRAPH_KINDS: ReadonlySet<GraphKind> = new Set<GraphKind>([
    'toolpack',
    'skillpack',
    'handler',
    'l1',
    'l2',
]);

function isGraphKind(value: unknown): value is GraphKind {
    return typeof value === 'string' && GRAPH_KINDS.has(value as GraphKind);
}

function readBody(req: FastifyRequest): Record<string, unknown> {
    return (req.body ?? {}) as Record<string, unknown>;
}

function bodyToGraph(
    body: Record<string, unknown>,
): Omit<Graph, 'id' | 'created_at' | 'updated_at'> | { error: string } {
    const { kind, nodes, edges, name, description, library } = body;
    if (!isGraphKind(kind)) {
        return {
            error: "kind must be 'toolpack', 'skillpack', 'handler', 'l1' or 'l2'",
        };
    }
    if (!Array.isArray(nodes)) return { error: 'nodes must be an array' };
    if (!Array.isArray(edges)) return { error: 'edges must be an array' };
    return {
        kind,
        nodes: nodes as Graph['nodes'],
        edges: edges as Graph['edges'],
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof description === 'string' ? { description } : {}),
        ...(library === true ? { library: true } : {}),
    };
}

export function registerGraphRoutes(app: FastifyInstance, deps: GraphRoutesDeps): void {
    const { graphStore, runtimes } = deps;

    app.get('/graphs', async (req: FastifyRequest<{ Querystring: { kind?: string } }>) => {
        const filter = isGraphKind(req.query.kind) ? { kind: req.query.kind } : undefined;
        const graphs = await graphStore.list(filter);
        const withStatus = graphs.map((g) => ({
            ...g,
            status: g.stopped
                ? ('stopped' as const)
                : (g.id && runtimes.get(g.id)) || graphIsAutonomous(g)
                  ? ('running' as const)
                  : ('idle' as const),
        }));
        return { graphs: withStatus };
    });

    app.post('/graphs', async (req, reply) => {
        const body = readBody(req);
        const draft = bodyToGraph(body);
        if ('error' in draft) {
            return reply.code(400).send({ error: draft.error });
        }
        const result = await createGraphPersist(graphStore, runtimes, draft);
        if (!result.ok) {
            const err = result.error;
            if (err.kind === 'conflict') {
                return reply.code(409).send({ error: err.message, conflicts: err.conflicts });
            }
            return reply.code(400).send({ error: err.message });
        }
        return reply.code(201).send({ graph: result.value.graph, remap: result.value.remap });
    });

    app.get<{ Params: IdParam }>('/graphs/:id', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const graph = await graphStore.get(id);
        if (!graph) return reply.code(404).send({ error: 'not found' });
        return { graph };
    });

    app.put<{ Params: IdParam }>('/graphs/:id', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const draft = bodyToGraph(readBody(req));
        if ('error' in draft) return reply.code(400).send({ error: draft.error });
        const result = await withGraphLock(id, () =>
            applyGraphEdit(graphStore, runtimes, id, draft),
        );
        if (!result.ok) {
            const err = result.error;
            if (err.kind === 'conflict') {
                return reply.code(409).send({ error: err.message, conflicts: err.conflicts });
            }
            if (err.kind === 'not_found') {
                return reply.code(404).send({ error: err.message });
            }
            if (err.kind === 'reload_failed') {
                return reply.code(500).send({ error: err.message });
            }
            return reply.code(400).send({ error: err.message });
        }
        return { graph: result.value.graph, remap: result.value.remap };
    });

    app.patch<{ Params: IdParam }>('/graphs/:id', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const body = readBody(req);
        const { name, description } = body;
        if (name !== undefined && typeof name !== 'string') {
            return reply.code(400).send({ error: 'name must be a string' });
        }
        if (description !== undefined && typeof description !== 'string') {
            return reply.code(400).send({ error: 'description must be a string' });
        }
        const updated = await withGraphLock(id, async () => {
            const existing = await graphStore.get(id);
            if (!existing) return { status: 'not_found' as const };
            if (existing.system === true) return { status: 'forbidden' as const };
            const { id: _id, created_at: _created, updated_at: _updated, ...rest } = existing;
            const next = await graphStore.update(id, {
                ...rest,
                ...(name !== undefined ? { name } : {}),
                ...(description !== undefined ? { description } : {}),
            });
            return next ? { status: 'ok' as const, graph: next } : { status: 'not_found' as const };
        });
        if (updated.status === 'not_found') return reply.code(404).send({ error: 'not found' });
        if (updated.status === 'forbidden') {
            return reply.code(403).send({ error: "can't edit a runner-owned starter template" });
        }
        return { graph: updated.graph };
    });

    app.delete<{ Params: IdParam }>('/graphs/:id', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const deleted = await withGraphLock(id, async () => {
            const existing = await graphStore.get(id);
            if (existing?.system === true) return null;
            if (runtimes.get(id)) await runtimes.unload(id);
            return deleteSubtree(graphStore, id, { includeRoot: true });
        });
        if (deleted === null) {
            return reply.code(403).send({ error: "can't delete a runner-owned starter template" });
        }
        if (!deleted.includes(id)) return reply.code(404).send({ error: 'not found' });
        deps.conversationLabels.deleteGraph(id);
        return reply.code(204).send();
    });

    app.post<{ Params: IdParam }>('/graphs/:id/instantiate', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        try {
            const { copy } = await instantiateLibraryGraph(graphStore, id);
            return reply.code(201).send({ graph: copy });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'instantiate failed';
            if (message.includes('not found')) {
                return reply.code(404).send({ error: message });
            }
            return reply.code(400).send({ error: message });
        }
    });

    app.post<{ Params: IdParam }>('/graphs/:id/clone', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        try {
            const { copy } = await cloneGraphTree(graphStore, id);
            return reply.code(201).send({ graph: copy });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'clone failed';
            if (message.includes('not found')) {
                return reply.code(404).send({ error: message });
            }
            return reply.code(400).send({ error: message });
        }
    });

    app.post<{ Params: IdParam }>('/graphs/:id/clone-subtree', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const body = readBody(req);
        const { nodes, edges } = body as { nodes?: unknown; edges?: unknown };
        if (!Array.isArray(nodes)) return reply.code(400).send({ error: 'nodes must be an array' });
        if (!Array.isArray(edges)) return reply.code(400).send({ error: 'edges must be an array' });

        type CloneOutcome =
            | { kind: 'early'; status: number; body: Record<string, unknown> }
            | {
                  kind: 'edit';
                  edit: Awaited<ReturnType<typeof applyGraphEdit>>;
                  cloneRemap: Record<string, string>;
              };
        const outcome = await withGraphLock<CloneOutcome>(id, async () => {
            const base = await graphStore.get(id);
            if (!base) {
                return { kind: 'early', status: 404, body: { error: 'not found' } };
            }
            let fragment: Awaited<ReturnType<typeof cloneSubtreeFragment>>;
            try {
                fragment = await cloneSubtreeFragment(graphStore, {
                    nodes: nodes as Node[],
                    edges: edges as Edge[],
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : 'clone-subtree failed';
                return { kind: 'early', status: 400, body: { error: message } };
            }
            const mintedRefIds = (nodes as Node[])
                .map((n) => refOf(n))
                .filter((r): r is string => !!r && !!fragment.remap[r])
                .map((oldRef) => fragment.remap[oldRef]!);
            const rollbackClone = async () => {
                for (const refId of mintedRefIds) {
                    await deleteSubtree(graphStore, refId, { includeRoot: true });
                }
            };

            const draft: GraphDraft = {
                kind: base.kind,
                nodes: [...base.nodes, ...fragment.nodes],
                edges: [...base.edges, ...fragment.edges],
                ...(base.name !== undefined ? { name: base.name } : {}),
                ...(base.description !== undefined ? { description: base.description } : {}),
            };

            let edit: Awaited<ReturnType<typeof applyGraphEdit>>;
            try {
                edit = await applyGraphEdit(graphStore, runtimes, id, draft);
            } catch (err) {
                await rollbackClone();
                throw err;
            }
            if (!edit.ok) {
                await rollbackClone();
            }
            return { kind: 'edit', edit, cloneRemap: fragment.remap };
        });

        if (outcome.kind === 'early') {
            return reply.code(outcome.status).send(outcome.body);
        }
        const { edit, cloneRemap } = outcome;
        if (!edit.ok) {
            const err = edit.error;
            if (err.kind === 'conflict') {
                return reply.code(409).send({ error: err.message, conflicts: err.conflicts });
            }
            if (err.kind === 'not_found') {
                return reply.code(404).send({ error: err.message });
            }
            if (err.kind === 'reload_failed') {
                return reply.code(500).send({ error: err.message });
            }
            return reply.code(400).send({ error: err.message });
        }
        const normalizeRemap = edit.value.remap;
        const remap: Record<string, string> = { ...normalizeRemap };
        for (const [oldId, freshId] of Object.entries(cloneRemap)) {
            remap[oldId] = normalizeRemap[freshId] ?? freshId;
        }
        return reply.code(200).send({ graph: edit.value.graph, remap });
    });

    app.post('/graphs/save-fragment', async (req, reply) => {
        const body = readBody(req);
        const { kind, nodes, edges, name } = body as {
            kind?: unknown;
            nodes?: unknown;
            edges?: unknown;
            name?: unknown;
        };
        if (!isGraphKind(kind)) {
            return reply.code(400).send({
                error: "kind must be 'toolpack', 'skillpack', 'handler', 'l1' or 'l2'",
            });
        }
        if (!Array.isArray(nodes)) return reply.code(400).send({ error: 'nodes must be an array' });
        if (!Array.isArray(edges)) return reply.code(400).send({ error: 'edges must be an array' });
        if (typeof name !== 'string' || !name) {
            return reply.code(400).send({ error: 'name must be a non-empty string' });
        }

        const refRemap = new Map<string, string>();
        let frozenNodes: Node[];
        try {
            frozenNodes = [];
            for (const node of nodes as Node[]) {
                frozenNodes.push(
                    await rewriteRefsInNode(graphStore, node, refRemap, { markLibrary: true }),
                );
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'save-fragment failed';
            return reply.code(400).send({ error: message });
        }

        const frozenCopyIds = [...refRemap.values()].filter((id) => isValidGraphId(id));

        const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind,
            nodes: frozenNodes,
            edges: edges as Edge[],
            name,
            library: true,
            fragment: true,
        };
        try {
            const created = await graphStore.create(draft);
            return reply.code(201).send({ graph: created });
        } catch (err) {
            for (const refId of frozenCopyIds) {
                await deleteSubtree(graphStore, refId, { includeRoot: true });
            }
            const message = err instanceof Error ? err.message : 'save-fragment failed';
            return reply.code(400).send({ error: message });
        }
    });

    app.post<{ Params: IdParam }>('/graphs/:id/ops', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const body = readBody(req);
        const parse = parseOps(body.ops);
        if (!parse.ok) {
            return reply.code(400).send({ error: parse.message, opIndex: parse.index });
        }
        type OpsOutcome =
            | { kind: 'early'; status: number; body: Record<string, unknown> }
            | {
                  kind: 'edit';
                  edit: Awaited<ReturnType<typeof applyGraphEdit>>;
                  opsResult: Extract<ReturnType<typeof applyOps>, { ok: true }>;
              };
        const outcome = await withGraphLock<OpsOutcome>(id, async () => {
            const base = await graphStore.get(id);
            if (!base) {
                return { kind: 'early', status: 404, body: { error: 'not found' } };
            }
            const { minted } = await mintMissingRefs(graphStore, parse.ops);
            const rollbackMint = async () => {
                for (const refId of minted) {
                    await deleteSubtree(graphStore, refId, { includeRoot: true });
                }
            };

            let edit: Awaited<ReturnType<typeof applyGraphEdit>>;
            let opsResult: ReturnType<typeof applyOps>;
            try {
                opsResult = applyOps(base, parse.ops);
                if (!opsResult.ok) {
                    await rollbackMint();
                    const { failure } = opsResult;
                    return {
                        kind: 'early',
                        status: 400,
                        body: {
                            error: failure.message,
                            code: failure.code,
                            op: failure.op,
                            opIndex: failure.index,
                        },
                    };
                }
                edit = await applyGraphEdit(graphStore, runtimes, id, opsResult.draft);
            } catch (err) {
                await rollbackMint();
                throw err;
            }
            if (!edit.ok) {
                await rollbackMint();
            }
            return { kind: 'edit', edit, opsResult };
        });
        if (outcome.kind === 'early') {
            return reply.code(outcome.status).send(outcome.body);
        }
        const { edit, opsResult } = outcome;
        if (!edit.ok) {
            const err = edit.error;
            if (err.kind === 'conflict') {
                return reply.code(409).send({ error: err.message, conflicts: err.conflicts });
            }
            if (err.kind === 'not_found') {
                return reply.code(404).send({ error: err.message });
            }
            if (err.kind === 'reload_failed') {
                return reply.code(500).send({ error: err.message });
            }
            return reply.code(400).send({ error: err.message });
        }
        for (const result of opsResult.results) {
            if (result.op === 'delete_node' && result.ok && result.orphanedRefId) {
                await deleteSubtree(graphStore, result.orphanedRefId, { includeRoot: true });
            }
        }
        const remap = { ...edit.value.remap, ...opsResult.placeholderRemap };
        return reply.code(200).send({
            graph: edit.value.graph,
            remap,
            results: opsResult.results,
        });
    });

    app.post<{ Params: IdParam }>('/graphs/:id/load', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const result = await withGraphLock<{ status: number; body: unknown }>(id, async () => {
            if (runtimes.get(id)) {
                return { status: 409, body: { error: 'graph already loaded' } };
            }
            const graph = await graphStore.get(id);
            if (!graph) return { status: 404, body: { error: 'not found' } };
            try {
                const loaded = await runtimes.load(graph);
                return { status: 200, body: snapshot(loaded) };
            } catch (err) {
                const message = err instanceof Error ? err.message : 'load failed';
                return { status: 400, body: { error: message } };
            }
        });
        return reply.code(result.status).send(result.body);
    });

    app.post<{ Params: IdParam }>('/graphs/:id/unload', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const ok = await withGraphLock(id, () => runtimes.unload(id));
        if (!ok) return reply.code(404).send({ error: 'not loaded' });
        return reply.code(200).send({ id, status: 'idle' });
    });

    app.post<{ Params: IdParam }>('/graphs/:id/activate', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const result = await withGraphLock<{ status: number; body: unknown }>(id, async () => {
            try {
                await runtimes.ensureLoaded(id);
                return { status: 200, body: { id, status: 'running' as const } };
            } catch (err) {
                const message = err instanceof Error ? err.message : 'activate failed';
                if (message.includes('not found')) {
                    return { status: 404, body: { error: 'not found' } };
                }
                return { status: 400, body: { error: message } };
            }
        });
        return reply.code(result.status).send(result.body);
    });

    app.post<{ Params: IdParam }>('/graphs/:id/stop', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const result = await withGraphLock<{ status: number; body: unknown }>(id, async () => {
            const g = await graphStore.get(id);
            if (!g) return { status: 404, body: { error: 'not found' } };
            await graphStore.update(id, { ...g, stopped: true });
            await runtimes.unload(id);
            return { status: 200, body: { id, status: 'stopped' as const } };
        });
        return reply.code(result.status).send(result.body);
    });

    app.post<{ Params: IdParam }>('/graphs/:id/resume', async (req, reply) => {
        const { id } = req.params;
        if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
        const result = await withGraphLock<{ status: number; body: unknown }>(id, async () => {
            const g = await graphStore.get(id);
            if (!g) return { status: 404, body: { error: 'not found' } };
            const resumed = await graphStore.update(id, { ...g, stopped: false });
            if (!resumed) return { status: 404, body: { error: 'not found' } };
            try {
                await runtimes.syncPin(resumed);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'resume failed';
                return { status: 400, body: { error: message } };
            }
            const status = graphIsAutonomous(resumed) ? 'running' : 'idle';
            return { status: 200, body: { id, status } };
        });
        return reply.code(result.status).send(result.body);
    });

    app.get<{ Params: { l1Id: string } }>(
        '/graphs/:l1Id/parent-context',
        async (req: FastifyRequest<{ Params: { l1Id: string } }>, reply: FastifyReply) => {
            const { l1Id } = req.params;
            if (!isValidGraphId(l1Id)) return reply.code(400).send({ error: 'invalid id' });
            const empty = {
                parentGraphId: null,
                parentAgentNodeId: null,
                nodes: [] as Node[],
                edges: [] as Edge[],
            };
            const parent = await findParentNativeAgentForL1(graphStore, l1Id);
            if (!parent) return empty;
            const agentId = parent.agentNode.id;
            const wiredNodeIds = new Set<string>();
            const wiredEdges: Edge[] = [];
            for (const e of parent.graph.edges) {
                if (e.source.node_id === agentId && e.target.node_id !== agentId) {
                    wiredNodeIds.add(e.target.node_id);
                    wiredEdges.push(e);
                } else if (e.target.node_id === agentId && e.source.node_id !== agentId) {
                    wiredNodeIds.add(e.source.node_id);
                    wiredEdges.push(e);
                }
            }
            const nodes = parent.graph.nodes.filter((n) => wiredNodeIds.has(n.id));
            return {
                parentGraphId: parent.graph.id ?? null,
                parentAgentNodeId: agentId,
                nodes,
                edges: wiredEdges,
            };
        },
    );

    app.get<{ Params: IdParam }>(
        '/graphs/:id/introspect',
        async (req: FastifyRequest<{ Params: IdParam }>, reply: FastifyReply) => {
            const { id } = req.params;
            if (!isValidGraphId(id)) return reply.code(400).send({ error: 'invalid id' });
            const loaded = runtimes.get(id);
            if (!loaded) return reply.code(404).send({ error: 'not loaded' });
            return snapshot(loaded);
        },
    );
}

function snapshot(loaded: ReturnType<GraphRuntimeRegistry['get']>) {
    if (!loaded) return null;
    const running: NodeRuntimeStateWire[] = [...loaded.nodeStates.values()];
    return {
        id: loaded.graph.id,
        status: loaded.status,
        sources: [...loaded.sources.keys()],
        subscriptions: [...loaded.subscriptions],
        running,
    };
}
