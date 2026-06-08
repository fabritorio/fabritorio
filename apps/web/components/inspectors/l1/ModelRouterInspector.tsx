import type { Edge, ModelNode, ModelRouterNode, Node } from '@fabritorio/types';
import { HeaderRow, Label } from '../shared';

interface RouterChildRow {
    edge: Edge;
    child: ModelNode | ModelRouterNode;
}

function sortRouterChildren(rows: ReadonlyArray<RouterChildRow>): ReadonlyArray<RouterChildRow> {
    return rows
        .map((row, idx) => ({ row, idx }))
        .sort((a, b) => {
            const ap = a.row.edge.priority;
            const bp = b.row.edge.priority;
            if (ap === bp) return a.idx - b.idx;
            if (ap === undefined) return 1;
            if (bp === undefined) return -1;
            return ap - bp;
        })
        .map((x) => x.row);
}

function resolveHeadlineModelForRouter(
    router: ModelRouterNode,
    nodes: ReadonlyArray<Node>,
    edges: ReadonlyArray<Edge>,
): ModelNode | null {
    const outbound: RouterChildRow[] = [];
    for (const e of edges) {
        if (e.source.node_id !== router.id) continue;
        const child = nodes.find((n) => n.id === e.target.node_id);
        if (!child) continue;
        if (child.type !== 'model' && child.type !== 'model_router') continue;
        outbound.push({ edge: e, child: child as ModelNode | ModelRouterNode });
    }
    if (outbound.length === 0) return null;
    const top = sortRouterChildren(outbound)[0]!.child;
    if (top.type === 'model') return top;
    return resolveHeadlineModelForRouter(top, nodes, edges);
}

export function ModelRouterInspector({
    node,
    allNodes,
    allEdges,
    onChange,
    onEdgeChange,
}: {
    node: ModelRouterNode;
    allNodes: ReadonlyArray<Node>;
    allEdges: ReadonlyArray<Edge>;
    onChange: (id: string, patch: Partial<Node>) => void;
    onEdgeChange?: (id: string, patch: Partial<Edge>) => void;
}) {
    const rows: RouterChildRow[] = [];
    for (const e of allEdges) {
        if (e.source.node_id !== node.id) continue;
        const child = allNodes.find((n) => n.id === e.target.node_id);
        if (!child) continue;
        if (child.type !== 'model' && child.type !== 'model_router') continue;
        rows.push({ edge: e, child: child as ModelNode | ModelRouterNode });
    }
    const sorted = sortRouterChildren(rows);

    const swap = (i: number, j: number) => {
        if (!onEdgeChange) return;
        if (i < 0 || j < 0 || i >= sorted.length || j >= sorted.length) return;
        const newOrder = sorted.slice();
        const tmp = newOrder[i]!;
        newOrder[i] = newOrder[j]!;
        newOrder[j] = tmp;
        newOrder.forEach((row, idx) => {
            onEdgeChange(row.edge.id, { priority: idx });
        });
    };

    const headline =
        sorted.length === 0
            ? null
            : sorted[0]!.child.type === 'model'
              ? (sorted[0]!.child as ModelNode)
              : resolveHeadlineModelForRouter(
                    sorted[0]!.child as ModelRouterNode,
                    allNodes,
                    allEdges,
                );

    return (
        <div className="space-y-3">
            <HeaderRow label="Model Router" id={node.id} />
            <div>
                <Label>Policy</Label>
                <select
                    value={node.policy}
                    onChange={(e) =>
                        onChange(node.id, {
                            policy: e.target.value as ModelRouterNode['policy'],
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="failover">failover</option>
                    <option value="round_robin" disabled>
                        round_robin (coming soon)
                    </option>
                    <option value="weighted" disabled>
                        weighted (coming soon)
                    </option>
                </select>
            </div>
            <div>
                <Label>Models (failover order)</Label>
                {sorted.length === 0 ? (
                    <p className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                        No Models wired. Drag a Model (or another Router) onto the canvas and wire
                        it into this Router.
                    </p>
                ) : (
                    <ol className="space-y-1">
                        {sorted.map((row, idx) => {
                            const isTop = idx === 0;
                            const isBottom = idx === sorted.length - 1;
                            const display =
                                row.child.type === 'model'
                                    ? `(unnamed) — ${row.child.provider}:${row.child.model_id}`
                                    : `(router) — router`;
                            return (
                                <li
                                    key={row.edge.id}
                                    className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                                >
                                    <span className="font-mono text-zinc-500 dark:text-zinc-500">
                                        {idx}.
                                    </span>
                                    <span className="flex-1 truncate" title={display}>
                                        {display}
                                    </span>
                                    <button
                                        type="button"
                                        disabled={isTop || !onEdgeChange}
                                        onClick={() => swap(idx, idx - 1)}
                                        aria-label="Move up"
                                        className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                    >
                                        ↑
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isBottom || !onEdgeChange}
                                        onClick={() => swap(idx, idx + 1)}
                                        aria-label="Move down"
                                        className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                    >
                                        ↓
                                    </button>
                                </li>
                            );
                        })}
                    </ol>
                )}
            </div>
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                <span className="font-medium">Primary:</span>{' '}
                {headline ? (
                    <code className="font-mono">
                        {headline.provider}:{headline.model_id}
                    </code>
                ) : (
                    <span className="text-zinc-500 dark:text-zinc-500">(no Model wired)</span>
                )}
            </div>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                The Router resolves to a single synthetic ModelClient at Dispatch time. On a
                pre-stream failure (429, 5xx, network) it falls through to the next Model.
                Mid-stream errors are not recovered.
            </p>
        </div>
    );
}
