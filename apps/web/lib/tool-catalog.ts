import type { ToolSpecSummary } from './runner-client';

export interface GroupedToolCatalog {
    builtin: ToolSpecSummary[];
    runtime: ToolSpecSummary[];
}

export function groupToolsBySource(tools: ReadonlyArray<ToolSpecSummary>): GroupedToolCatalog {
    const builtin: ToolSpecSummary[] = [];
    const runtime: ToolSpecSummary[] = [];
    for (const t of tools) {
        if (t.source === 'runtime') runtime.push(t);
        else builtin.push(t);
    }
    return { builtin, runtime };
}
