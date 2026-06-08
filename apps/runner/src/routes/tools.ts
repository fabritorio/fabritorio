import type { FastifyInstance } from 'fastify';
import { BUILTIN_TOOL_SPECS } from '../runtime/builtin-tools.js';
import type { RuntimeToolRegistry } from '../runtime/runtime-tools.js';
import type { ToolSpec } from '../runtime/tools.js';

export interface ToolRoutesDeps {
    runtimeToolRegistry?: RuntimeToolRegistry;
}

interface ToolSpecProjection extends ToolSpec {
    source: 'builtin' | 'runtime';
}

export function registerToolRoutes(app: FastifyInstance, deps: ToolRoutesDeps = {}): void {
    app.get('/tools', async () => {
        const builtinProj: ToolSpecProjection[] = BUILTIN_TOOL_SPECS.map((s) => ({
            ...s,
            source: 'builtin',
        }));
        if (!deps.runtimeToolRegistry) {
            return { tools: builtinProj };
        }
        deps.runtimeToolRegistry.rescan();
        const runtimeProj: ToolSpecProjection[] = deps.runtimeToolRegistry
            .list()
            .map((s) => ({ ...s, source: 'runtime' }));
        return { tools: [...builtinProj, ...runtimeProj] };
    });
}
