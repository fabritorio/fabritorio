import type { Edge, Graph, GraphKind, Node } from '@fabritorio/types';

export interface Fragment {
    kind: GraphKind;
    nodes: Node[];
    edges: Edge[];
}

export function extractFragment(
    graph: Graph,
    selectedIds: ReadonlySet<string> | ReadonlyArray<string>,
): Fragment {
    const selection = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
    const nodes = graph.nodes.filter((n) => selection.has(n.id));
    const present = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter(
        (e) => present.has(e.source.node_id) && present.has(e.target.node_id),
    );
    return { kind: graph.kind, nodes, edges };
}
