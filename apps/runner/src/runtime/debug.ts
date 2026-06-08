import type { DispatchEvent } from '@fabritorio/types';

export type DebugLayer = 'l1' | 'l2';

export interface DebugPublishArgs {
    content: string;
    source?: string;
}

export interface DebugGatewayHandle {
    graphId: string;
    nodeId: string;
    layer: DebugLayer;
    publish(args: DebugPublishArgs): Promise<DispatchEvent>;
    subscribe(listener: (event: DispatchEvent) => void): () => void;
    onTeardown(closer: () => void): () => void;
    deliver(event: DispatchEvent): void;
    rootsBySource(source: string): string[];
    teardown(): void;
}

export interface DebugGatewayRegistry {
    register(handle: DebugGatewayHandle): void;
    unregister(graphId: string, nodeId: string): void;
    get(graphId: string, nodeId: string): DebugGatewayHandle | undefined;
    list(): DebugGatewayHandle[];
}

export function debugKey(graphId: string, nodeId: string): string {
    return `${graphId}:${nodeId}`;
}

export function createDebugGatewayRegistry(): DebugGatewayRegistry {
    const byKey = new Map<string, DebugGatewayHandle>();
    return {
        register(handle) {
            const key = debugKey(handle.graphId, handle.nodeId);
            if (byKey.has(key)) {
                throw new Error(`debug_gateway ${key} is already registered`);
            }
            byKey.set(key, handle);
        },
        unregister(graphId, nodeId) {
            byKey.delete(debugKey(graphId, nodeId));
        },
        get(graphId, nodeId) {
            return byKey.get(debugKey(graphId, nodeId));
        },
        list() {
            return [...byKey.values()];
        },
    };
}
