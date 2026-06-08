import type { TriggerNode } from '@fabritorio/types';

export interface TriggerFireCtx {
    message?: string;
    meta?: Record<string, unknown>;
    source?: string;
}

export type TriggerFire = (ctx?: TriggerFireCtx) => Promise<void>;

export interface TriggerStrategyInput {
    node: TriggerNode;
    nodeId: string;
    fire: TriggerFire;
}

export interface TriggerStrategy {
    activate(): Promise<TriggerStrategyHandle> | TriggerStrategyHandle;
}

export interface TriggerStrategyHandle {
    deactivate(): void | Promise<void>;
}

export type TriggerStrategyFactory = (input: TriggerStrategyInput) => TriggerStrategy;

export interface TriggerStrategyRegistry {
    register(kind: TriggerNode['trigger_kind'], factory: TriggerStrategyFactory): void;
    get(kind: TriggerNode['trigger_kind']): TriggerStrategyFactory | undefined;
}

export function createTriggerStrategyRegistry(): TriggerStrategyRegistry {
    const factories = new Map<TriggerNode['trigger_kind'], TriggerStrategyFactory>();
    return {
        register(kind, factory) {
            factories.set(kind, factory);
        },
        get(kind) {
            return factories.get(kind);
        },
    };
}
