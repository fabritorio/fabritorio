import type { MemoryNode } from '@fabritorio/types';
import type { NodeBinding } from '../graph-runtime.js';
import type { MemoryRegistry } from '../memory.js';

export interface MemoryBindingDeps {
    registry: MemoryRegistry;
}

export function createMemoryBinding(deps: MemoryBindingDeps): NodeBinding {
    return {
        activate(ctx) {
            if (ctx.node.type !== 'memory') return null;
            deps.registry.resolve(ctx.node as MemoryNode);
            return null;
        },
    };
}
