import type { Graph, Node } from '@fabritorio/types';
import type { GraphDraft, RunnerClient } from './runner-client';

export const FABRITORIO_BUNDLE_VERSION = 1;

export interface Bundle {
    fabritorio: typeof FABRITORIO_BUNDLE_VERSION;
    root_id: string;
    graphs: Graph[];
}

function collectRefIds(node: Node): string[] {
    const out: string[] = [];
    if (node.type === 'native_agent') {
        if (typeof node.l1_graph_id === 'string' && node.l1_graph_id.length > 0) {
            out.push(node.l1_graph_id);
        }
        return out;
    }
    if (
        (node.type === 'tool_pack' || node.type === 'skill_pack' || node.type === 'handler') &&
        typeof node.ref_id === 'string' &&
        node.ref_id.length > 0
    ) {
        out.push(node.ref_id);
    }
    return out;
}

export async function collectBundle(client: RunnerClient, rootId: string): Promise<Bundle> {
    const seen = new Set<string>();
    const queue: string[] = [rootId];
    const graphs: Graph[] = [];
    while (queue.length > 0) {
        const id = queue.shift() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const summary = await client.getGraph(id);
        if (!summary) {
            console.warn(`collectBundle: graph ${id} not found, skipping`);
            continue;
        }
        graphs.push(summary.graph);
        for (const node of summary.graph.nodes) {
            for (const ref of collectRefIds(node)) {
                if (!seen.has(ref)) queue.push(ref);
            }
        }
    }
    return { fabritorio: FABRITORIO_BUNDLE_VERSION, root_id: rootId, graphs };
}

export function isBundle(value: unknown): value is Bundle {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<Bundle>;
    if (v.fabritorio !== FABRITORIO_BUNDLE_VERSION) return false;
    if (typeof v.root_id !== 'string' || v.root_id.length === 0) return false;
    if (!Array.isArray(v.graphs)) return false;
    for (const g of v.graphs) {
        if (!g || typeof g !== 'object') return false;
        if (typeof (g as Graph).kind !== 'string') return false;
        if (!Array.isArray((g as Graph).nodes)) return false;
        if (!Array.isArray((g as Graph).edges)) return false;
    }
    return true;
}

export function parseBundleText(text: string): Bundle | null {
    if (!text) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    return isBundle(parsed) ? parsed : null;
}

function toDraft(graph: Graph, nameOverride?: string): GraphDraft {
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = graph;
    void _id;
    void _c;
    void _u;
    if (nameOverride !== undefined) {
        return { ...rest, name: nameOverride };
    }
    return rest;
}

function rewriteRefsOnNode(node: Node, idMap: Map<string, string>): Node {
    if (node.type === 'native_agent') {
        const mapped = idMap.get(node.l1_graph_id);
        return mapped ? { ...node, l1_graph_id: mapped } : node;
    }
    if (node.type === 'tool_pack' || node.type === 'skill_pack' || node.type === 'handler') {
        if (typeof node.ref_id === 'string' && node.ref_id.length > 0) {
            const mapped = idMap.get(node.ref_id);
            if (mapped) {
                return { ...node, ref_id: mapped };
            }
        }
    }
    return node;
}

function rewriteGraphRefs(graph: Graph, idMap: Map<string, string>): Graph {
    return { ...graph, nodes: graph.nodes.map((n) => rewriteRefsOnNode(n, idMap)) };
}

export async function installBundle(
    client: RunnerClient,
    bundle: Bundle,
    opts?: { rootNameSuffix?: string },
): Promise<{ rootId: string }> {
    if (!bundle.graphs.some((g) => g.id === bundle.root_id)) {
        throw new Error(`installBundle: root_id ${bundle.root_id} is not present in graphs[]`);
    }
    const idMap = new Map<string, string>();
    const created: Array<{ oldGraph: Graph; newId: string }> = [];
    for (const graph of bundle.graphs) {
        const oldId = graph.id;
        if (typeof oldId !== 'string' || oldId.length === 0) {
            throw new Error('installBundle: graph in bundle missing id');
        }
        const isRoot = oldId === bundle.root_id;
        const nameOverride =
            isRoot && opts?.rootNameSuffix
                ? `${graph.name ?? 'Untitled'}${opts.rootNameSuffix}`
                : undefined;
        const summary = await client.createGraph(toDraft(graph, nameOverride));
        idMap.set(oldId, summary.id);
        created.push({ oldGraph: graph, newId: summary.id });
    }
    for (const { oldGraph, newId } of created) {
        const rewritten = rewriteGraphRefs(oldGraph, idMap);
        const isRoot = oldGraph.id === bundle.root_id;
        const nameOverride =
            isRoot && opts?.rootNameSuffix
                ? `${oldGraph.name ?? 'Untitled'}${opts.rootNameSuffix}`
                : undefined;
        await client.updateGraph(newId, toDraft(rewritten, nameOverride));
    }
    const newRoot = idMap.get(bundle.root_id);
    if (!newRoot) {
        throw new Error('installBundle: root id missing from id map after create');
    }
    return { rootId: newRoot };
}
