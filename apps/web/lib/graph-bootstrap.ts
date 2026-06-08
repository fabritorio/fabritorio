'use client';

import type { Graph, GraphKind } from '@fabritorio/types';
import type { GraphSummary, RunnerClient } from './runner-client';
import { loadCurrentGraphId, storeCurrentGraphId } from './graph-persistence';

export async function bootstrapGraph(
    client: RunnerClient,
    fallbackKind: GraphKind = 'l1',
): Promise<GraphSummary> {
    const remembered = loadCurrentGraphId();
    if (remembered) {
        const fetched = await client.getGraph(remembered);
        if (fetched) return fetched;
        storeCurrentGraphId(null);
    }

    const list = await client.listGraphs();
    const userGraphs = list.filter((g) => !g.graph.library && !g.graph.system);
    if (userGraphs.length > 0) {
        const newest = userGraphs[0]!;
        storeCurrentGraphId(newest.id);
        return newest;
    }

    const created = await createStarterGraph(client, fallbackKind);
    storeCurrentGraphId(created.id);
    return created;
}

export async function createStarterGraph(
    client: RunnerClient,
    kind: GraphKind,
): Promise<GraphSummary> {
    return client.createGraphFromStarter(kind);
}

export function buildOfflineFallbackGraph(): Graph {
    return { kind: 'l1', nodes: [], edges: [] };
}

export async function buildResetSampleGraph(client: RunnerClient, kind: GraphKind): Promise<Graph> {
    const created = await client.createGraphFromStarter(kind);
    return created.graph;
}
