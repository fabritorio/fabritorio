import type { ManualTriggerRegistry } from './manual-registry.js';
import type { TriggerStrategy, TriggerStrategyFactory, TriggerStrategyHandle } from './strategy.js';

export interface ManualStrategyDeps {
    registry: ManualTriggerRegistry;
}

export function createManualStrategyFactory(deps: ManualStrategyDeps): TriggerStrategyFactory {
    return ({ node, nodeId, fire }) => {
        if (node.trigger_kind !== 'manual') {
            throw new Error(`manual strategy: trigger ${nodeId} has kind="${node.trigger_kind}"`);
        }
        const strategy: TriggerStrategy = {
            activate(): TriggerStrategyHandle {
                deps.registry.register({ nodeId, fire });
                return {
                    deactivate() {
                        deps.registry.unregister(nodeId);
                    },
                };
            },
        };
        return strategy;
    };
}
