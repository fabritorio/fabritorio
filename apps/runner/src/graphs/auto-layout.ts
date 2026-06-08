import type { Edge, Graph, Node } from '@fabritorio/types';

const COLUMN_STRIDE = 240;
const ROW_STRIDE = 160;

function hasUserPosition(node: Node): boolean {
    const p = node.position;
    if (!p) return false;
    return !(p.x === 0 && p.y === 0);
}

function buildSuccessors(nodes: Node[], edges: Edge[]): Map<string, string[]> {
    const ids = new Set(nodes.map((n) => n.id));
    const succ = new Map<string, string[]>();
    for (const n of nodes) succ.set(n.id, []);
    for (const e of edges) {
        const s = e.source.node_id;
        const t = e.target.node_id;
        if (!ids.has(s) || !ids.has(t)) continue;
        const list = succ.get(s);
        if (list) list.push(t);
    }
    return succ;
}

function buildPredecessors(nodes: Node[], edges: Edge[]): Map<string, string[]> {
    const ids = new Set(nodes.map((n) => n.id));
    const pred = new Map<string, string[]>();
    for (const n of nodes) pred.set(n.id, []);
    for (const e of edges) {
        const s = e.source.node_id;
        const t = e.target.node_id;
        if (!ids.has(s) || !ids.has(t)) continue;
        const list = pred.get(t);
        if (list) list.push(s);
    }
    return pred;
}

function computeRanks(nodes: Node[], edges: Edge[]): Map<string, number> {
    const succ = buildSuccessors(nodes, edges);
    const pred = buildPredecessors(nodes, edges);
    const ranks = new Map<string, number>();

    const indeg = new Map<string, number>();
    for (const n of nodes) indeg.set(n.id, pred.get(n.id)?.length ?? 0);

    const queue: string[] = [];
    for (const n of nodes) {
        if ((indeg.get(n.id) ?? 0) === 0) {
            ranks.set(n.id, 0);
            queue.push(n.id);
        }
    }

    while (queue.length > 0) {
        const id = queue.shift()!;
        const r = ranks.get(id) ?? 0;
        for (const child of succ.get(id) ?? []) {
            const cr = ranks.get(child);
            const candidate = r + 1;
            if (cr === undefined || candidate > cr) ranks.set(child, candidate);
            const remaining = (indeg.get(child) ?? 0) - 1;
            indeg.set(child, remaining);
            if (remaining === 0) queue.push(child);
        }
    }

    for (const n of nodes) {
        if (ranks.has(n.id)) continue;
        ranks.set(n.id, 0);
        const bfs: string[] = [n.id];
        while (bfs.length > 0) {
            const id = bfs.shift()!;
            const r = ranks.get(id) ?? 0;
            for (const child of succ.get(id) ?? []) {
                if (ranks.has(child)) continue;
                ranks.set(child, r + 1);
                bfs.push(child);
            }
        }
    }

    return ranks;
}

export function autoLayout(graph: Graph): Graph {
    const { nodes, edges } = graph;
    if (nodes.length === 0) return graph;

    const ranks = computeRanks(nodes, edges);

    const columns = new Map<number, Node[]>();
    for (const n of nodes) {
        if (hasUserPosition(n)) continue;
        const col = ranks.get(n.id) ?? 0;
        const bucket = columns.get(col);
        if (bucket) bucket.push(n);
        else columns.set(col, [n]);
    }

    const placed = new Map<string, { x: number; y: number }>();
    for (const [col, bucket] of columns) {
        const sorted = [...bucket].sort((a, b) => {
            if (a.type !== b.type) return a.type < b.type ? -1 : 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        sorted.forEach((node, row) => {
            placed.set(node.id, { x: col * COLUMN_STRIDE, y: row * ROW_STRIDE });
        });
    }

    const laidOut = nodes.map((n) => {
        const pos = placed.get(n.id);
        return pos ? { ...n, position: pos } : n;
    });

    return { ...graph, nodes: laidOut };
}
