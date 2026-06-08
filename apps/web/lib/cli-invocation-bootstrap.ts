import type { GraphSummary, RunnerClient } from './runner-client';

export interface CreateCliInvocationOptions {
    defaultName: string;
    targetDisplayName?: string;
}

export async function createCliInvocationGraph(
    client: RunnerClient,
    opts: CreateCliInvocationOptions,
): Promise<GraphSummary> {
    const created = await client.createGraphFromStarter('cli_invocation', {
        name: opts.defaultName,
    });
    const trimmed = opts.targetDisplayName?.trim();
    if (!trimmed) return created;
    const target = created.graph.nodes.find((n) => n.type === 'cli_invocation_target');
    if (!target) return created;
    const result = await client.applyGraphOps(created.id, [
        {
            op: 'update_node_config',
            id: target.id,
            patch: { display_name: trimmed },
        },
    ]);
    return {
        ...created,
        graph: result.graph,
    };
}
