import type { Edge, Graph, Node } from '@fabritorio/types';
import type { GraphStore } from './store.js';
import { freshenGraphContents } from './instantiate.js';
import { isAgentType } from './invariant.js';
import { ensureAllAgentSidecars } from './sidecar.js';

export interface MigrationSummary {
    graphsCopied: number;
    graphsRewritten: number;
    passes: number;
}

interface RefSite {
    graphId: string;
    nodeId: string;
}

export interface MigrateOptions {
    log?: (line: string) => void;
}

export async function migrateDuplicateRefs(
    store: GraphStore,
    opts: MigrateOptions = {},
): Promise<MigrationSummary> {
    const log = opts.log ?? (() => undefined);

    let graphsCopied = 0;
    const rewrittenGraphIds = new Set<string>();
    let passes = 0;

    const MAX_PASSES = 32;
    for (let i = 0; i < MAX_PASSES; i++) {
        const all = await store.list();
        const usage = buildUsageMap(all);
        const duplicates = [...usage.entries()].filter(([, sites]) => sites.length >= 2);
        if (duplicates.length === 0) break;
        passes = i + 1;

        for (const [refId, sites] of duplicates) {
            const target = await store.get(refId);
            if (!target) {
                continue;
            }
            const skipFirst = target.library !== true;
            const sitesToRewrite = skipFirst ? sites.slice(1) : sites;
            for (const site of sitesToRewrite) {
                const copy = await flatCopyGraph(store, target);
                graphsCopied++;
                await rewriteRef(store, site, refId, copy.id!);
                rewrittenGraphIds.add(site.graphId);
            }
        }
    }

    if (graphsCopied > 0) {
        log(
            `composite-by-value migration: migrated ${graphsCopied} duplicate refs across ${rewrittenGraphIds.size} graphs in ${passes} pass(es)`,
        );
    }

    return {
        graphsCopied,
        graphsRewritten: rewrittenGraphIds.size,
        passes,
    };
}

export interface SidecarBackfillSummary {
    graphsBackfilled: number;
    sidecarsMinted: number;
}

export async function migrateAgentSidecars(
    store: GraphStore,
    opts: MigrateOptions = {},
): Promise<SidecarBackfillSummary> {
    const log = opts.log ?? (() => undefined);
    const all = await store.list();
    let graphsBackfilled = 0;
    let sidecarsMinted = 0;

    for (const g of all) {
        if (!g.id) continue;
        if (!g.nodes.some((n) => isAgentType(n.type))) continue;
        const before = g.nodes.length;
        const next = ensureAllAgentSidecars(g);
        const minted = next.nodes.length - before;
        if (minted <= 0) continue;
        sidecarsMinted += minted;
        graphsBackfilled += 1;
        const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: next.kind,
            nodes: next.nodes,
            edges: next.edges,
            ...(g.name !== undefined ? { name: g.name } : {}),
            ...(g.description !== undefined ? { description: g.description } : {}),
            ...(g.library === true ? { library: true } : {}),
            ...(g.system === true ? { system: true } : {}),
            ...(g.stopped !== undefined ? { stopped: g.stopped } : {}),
        };
        await store.update(g.id, draft);
    }

    if (graphsBackfilled > 0) {
        log(
            `chat-sidecar backfill: minted ${sidecarsMinted} sidecar(s) across ${graphsBackfilled} graph(s)`,
        );
    }
    return { graphsBackfilled, sidecarsMinted };
}

function buildUsageMap(all: readonly Graph[]): Map<string, RefSite[]> {
    const usage = new Map<string, RefSite[]>();
    const record = (refId: string, site: RefSite) => {
        let arr = usage.get(refId);
        if (!arr) {
            arr = [];
            usage.set(refId, arr);
        }
        arr.push(site);
    };
    for (const g of all) {
        if (!g.id) continue;
        for (const node of g.nodes) {
            if (
                node.type === 'native_agent' &&
                typeof node.l1_graph_id === 'string' &&
                node.l1_graph_id
            ) {
                record(node.l1_graph_id, { graphId: g.id, nodeId: node.id });
                continue;
            }
            if ('ref_id' in node && typeof node.ref_id === 'string' && node.ref_id) {
                record(node.ref_id, { graphId: g.id, nodeId: node.id });
            }
        }
    }
    return usage;
}

async function flatCopyGraph(store: GraphStore, source: Graph): Promise<Graph> {
    const { nodes, edges } = freshenGraphContents({
        nodes: source.nodes,
        edges: source.edges,
    });
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: source.kind,
        nodes,
        edges,
        ...(source.name ? { name: source.name } : {}),
        ...(source.description ? { description: source.description } : {}),
    };
    return store.create(draft);
}

async function rewriteRef(
    store: GraphStore,
    site: RefSite,
    oldRefId: string,
    newRefId: string,
): Promise<void> {
    const parent = await store.get(site.graphId);
    if (!parent) return;
    let mutated = false;
    const newNodes: Node[] = parent.nodes.map((node) => {
        if (node.id !== site.nodeId) return node;
        if (node.type === 'native_agent' && node.l1_graph_id === oldRefId) {
            mutated = true;
            return { ...node, l1_graph_id: newRefId };
        }
        if ('ref_id' in node && node.ref_id === oldRefId) {
            mutated = true;
            return { ...node, ref_id: newRefId };
        }
        return node;
    });
    if (!mutated) return;
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: parent.kind,
        nodes: newNodes,
        edges: parent.edges as Edge[],
        ...(parent.name ? { name: parent.name } : {}),
        ...(parent.description ? { description: parent.description } : {}),
        ...(parent.library === true ? { library: true } : {}),
    };
    await store.update(site.graphId, draft);
}
