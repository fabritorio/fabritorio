import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Edge, Graph, MemoryNode, NativeAgentNode, NodeType } from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';

export function expandHomePath(p: string | undefined): string | undefined {
    if (!p) return p;
    if (p === '~') return homedir();
    if (p.startsWith('~/')) return join(homedir(), p.slice(2));
    return p;
}

export function findWiredMemoryNodes(l2: Graph, agentId: string): MemoryNode[] {
    const memoryById = new Map<string, MemoryNode>();
    for (const n of l2.nodes) {
        if (n.type === 'memory') memoryById.set(n.id, n as MemoryNode);
    }
    if (memoryById.size === 0) return [];
    const seen = new Set<string>();
    const out: MemoryNode[] = [];
    const consider = (id: string) => {
        if (seen.has(id)) return;
        const m = memoryById.get(id);
        if (!m) return;
        seen.add(id);
        out.push(m);
    };
    for (const e of l2.edges) {
        if (e.target.node_id === agentId) consider(e.source.node_id);
        if (e.source.node_id === agentId) consider(e.target.node_id);
    }
    return out;
}

export function makeIsReferenceEdge(
    referenceSourceTypes: ReadonlySet<NodeType>,
): (graph: Graph, edge: Edge) => boolean {
    return (graph, edge) => {
        const src = graph.nodes.find((n) => n.id === edge.source.node_id);
        if (!src) return false;
        return referenceSourceTypes.has(src.type);
    };
}

export interface ParentNativeAgentSite {
    graph: Graph;
    agentNode: NativeAgentNode;
}

export async function findParentNativeAgentForL1(
    store: GraphStore,
    l1Id: string,
): Promise<ParentNativeAgentSite | null> {
    if (!l1Id) return null;
    const all = await store.list();
    for (const g of all) {
        for (const node of g.nodes) {
            if (node.type !== 'native_agent') continue;
            const agent = node as NativeAgentNode;
            if (agent.l1_graph_id === l1Id) {
                return { graph: g, agentNode: agent };
            }
        }
    }
    return null;
}
