import type { Graph } from '@fabritorio/types';
import { autoLayout } from './auto-layout.js';
import { applyGraphDefaults } from './defaults.js';
import { normalizeGraphIds } from './ids.js';
import { checkTopology, checkUniqueRefs, topologyMessage, type RefConflict } from './invariant.js';
import { migrateMemoryNodesInGraph } from '../runtime/memory.js';
import type { GraphStore } from './store.js';
import type { GraphRuntimeRegistry } from '../runtime/graph-runtime.js';

export type GraphDraft = Omit<Graph, 'id' | 'created_at' | 'updated_at'>;

export type PersistError =
    | { kind: 'invalid'; message: string }
    | { kind: 'conflict'; message: string; conflicts: RefConflict[] }
    | { kind: 'not_found'; message: string }
    | { kind: 'reload_failed'; message: string; graph: Graph };

export type PersistResult<T> = { ok: true; value: T } | { ok: false; error: PersistError };

export interface PersistedGraph {
    graph: Graph;
    remap: Record<string, string>;
}

export function runtimeSignature(graph: Graph): string {
    const nodes = [...graph.nodes]
        .map((n) => {
            const { position: _pos, ...rest } = n;
            void _pos;
            return rest;
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    const edges = [...graph.edges].sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({ kind: graph.kind, stopped: graph.stopped ?? false, nodes, edges });
}

export function conflictMessage(conflicts: ReadonlyArray<RefConflict>): string {
    const first = conflicts[0];
    if (!first) return 'ref conflict';
    const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : '';
    return `ref ${first.refId} is already referenced by graph ${first.otherGraphId} node ${first.otherNodeId}${more}`;
}

export async function createGraphPersist(
    store: GraphStore,
    _runtimes: GraphRuntimeRegistry,
    rawDraft: GraphDraft,
): Promise<PersistResult<PersistedGraph>> {
    void _runtimes;
    const migrated = migrateMemoryNodesInGraph(rawDraft as Graph) as GraphDraft;
    const normalized = await normalizeGraphIds(store, migrated, undefined);
    const defaulted = applyGraphDefaults({
        nodes: normalized.nodes,
        edges: normalized.edges,
    });
    const draft: GraphDraft = {
        ...migrated,
        nodes: defaulted.nodes,
        edges: defaulted.edges,
    };
    const topo = checkTopology(draft);
    if (!topo.ok) {
        return {
            ok: false,
            error: { kind: 'invalid', message: topologyMessage(topo.violations) },
        };
    }
    const check = await checkUniqueRefs(store, draft, undefined);
    if (!check.ok) {
        return {
            ok: false,
            error: {
                kind: 'conflict',
                message: conflictMessage(check.conflicts),
                conflicts: check.conflicts,
            },
        };
    }
    const laidOut = autoLayout(draft as Graph);
    const persisted = await store.create({
        ...draft,
        nodes: laidOut.nodes,
        edges: laidOut.edges,
    });
    return { ok: true, value: { graph: persisted, remap: normalized.remap } };
}

export async function applyGraphEdit(
    store: GraphStore,
    runtimes: GraphRuntimeRegistry,
    id: string,
    rawDraft: GraphDraft,
): Promise<PersistResult<PersistedGraph>> {
    const migrated = migrateMemoryNodesInGraph(rawDraft as Graph) as GraphDraft;
    const normalized = await normalizeGraphIds(store, migrated, id);
    const defaulted = applyGraphDefaults({
        nodes: normalized.nodes,
        edges: normalized.edges,
    });
    const draft: GraphDraft = {
        ...migrated,
        nodes: defaulted.nodes,
        edges: defaulted.edges,
    };
    const topo = checkTopology(draft);
    if (!topo.ok) {
        return {
            ok: false,
            error: { kind: 'invalid', message: topologyMessage(topo.violations) },
        };
    }
    const check = await checkUniqueRefs(store, draft, id);
    if (!check.ok) {
        return {
            ok: false,
            error: {
                kind: 'conflict',
                message: conflictMessage(check.conflicts),
                conflicts: check.conflicts,
            },
        };
    }
    const laidOut = autoLayout(draft as Graph);
    const loadedBefore = runtimes.get(id);
    const before = await store.get(id);
    const finalDraft: GraphDraft = {
        ...draft,
        nodes: laidOut.nodes,
        edges: laidOut.edges,
        stopped: before?.stopped,
    };
    const updated = await store.update(id, finalDraft);
    if (!updated) {
        return { ok: false, error: { kind: 'not_found', message: 'not found' } };
    }
    const sigChanged = before ? runtimeSignature(before) !== runtimeSignature(updated) : true;
    if (loadedBefore && sigChanged) {
        try {
            await runtimes.unload(id);
            await runtimes.load(updated);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'reload failed';
            return {
                ok: false,
                error: {
                    kind: 'reload_failed',
                    message: `graph saved but reload failed: ${message}`,
                    graph: updated,
                },
            };
        }
    }
    if (sigChanged) {
        await runtimes.reloadDependents(id).catch(() => undefined);
    }
    await runtimes.syncPin(updated);
    return { ok: true, value: { graph: updated, remap: normalized.remap } };
}
