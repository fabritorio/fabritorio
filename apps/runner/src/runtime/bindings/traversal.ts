import type { Edge } from '@fabritorio/types';
import type { NodeContext } from '../graph-runtime.js';

export function emitForwardTraversal(
    ctx: NodeContext,
    edge: Edge,
    eventId: string,
    portHint?: 'result' | 'error',
): void {
    ctx.bus.emitTraversal({
        type: 'edge.traversed',
        ts: new Date().toISOString(),
        eventId,
        graphId: ctx.graph.id ?? '',
        fromNodeId: edge.source.node_id,
        toNodeId: edge.target.node_id,
        edgeId: edge.id,
        direction: 'forward',
        ...(portHint ? { portHint } : {}),
    });
}
