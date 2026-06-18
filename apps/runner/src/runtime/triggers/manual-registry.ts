import type { TriggerFire } from './strategy.js';

export interface ManualTrigger {
    nodeId: string;
    fire: TriggerFire;
}

export interface ManualTriggerRegistry {
    register(trigger: ManualTrigger): void;
    unregister(nodeId: string): void;
    get(nodeId: string): ManualTrigger | undefined;
    list(): ManualTrigger[];
}

export function createManualTriggerRegistry(): ManualTriggerRegistry {
    const byId = new Map<string, ManualTrigger>();
    return {
        register(trigger) {
            if (byId.has(trigger.nodeId)) {
                throw new Error(`manual trigger ${trigger.nodeId} is already registered`);
            }
            byId.set(trigger.nodeId, trigger);
        },
        unregister(nodeId) {
            byId.delete(nodeId);
        },
        get(nodeId) {
            return byId.get(nodeId);
        },
        list() {
            return [...byId.values()];
        },
    };
}
