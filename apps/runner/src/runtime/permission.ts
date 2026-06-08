export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny';

export interface PermissionDecisionRequest {
    permissionNodeId: string;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    argSignature?: string;
    ts: string;
}

export interface PermissionGateHandle {
    graphId: string;
    nodeId: string;
    evaluate(call: {
        tool_name: string;
        args: Record<string, unknown>;
        call_id: string;
        signature?: string;
    }): Promise<'allow' | 'deny'>;
    pending(): PermissionDecisionRequest[];
    decide(callId: string, decision: PermissionDecision): boolean;
    subscribe(listener: (req: PermissionDecisionRequest) => void): () => void;
    onTeardown(closer: () => void): () => void;
    teardown(): void;
}

export interface PermissionGateRegistry {
    register(handle: PermissionGateHandle): void;
    unregister(graphId: string, nodeId: string): void;
    get(graphId: string, nodeId: string): PermissionGateHandle | undefined;
    forGraph(graphId: string): PermissionGateHandle[];
    list(): PermissionGateHandle[];
}

export function permissionGateKey(graphId: string, nodeId: string): string {
    return `${graphId}:${nodeId}`;
}

export function createPermissionGateRegistry(): PermissionGateRegistry {
    const byKey = new Map<string, PermissionGateHandle>();
    const byGraph = new Map<string, Set<PermissionGateHandle>>();
    return {
        register(handle) {
            const key = permissionGateKey(handle.graphId, handle.nodeId);
            if (byKey.has(key)) {
                throw new Error(`permission gate ${key} is already registered`);
            }
            byKey.set(key, handle);
            let set = byGraph.get(handle.graphId);
            if (!set) {
                set = new Set();
                byGraph.set(handle.graphId, set);
            }
            set.add(handle);
        },
        unregister(graphId, nodeId) {
            const key = permissionGateKey(graphId, nodeId);
            const handle = byKey.get(key);
            if (!handle) return;
            byKey.delete(key);
            const set = byGraph.get(graphId);
            if (set) {
                set.delete(handle);
                if (set.size === 0) byGraph.delete(graphId);
            }
        },
        get(graphId, nodeId) {
            return byKey.get(permissionGateKey(graphId, nodeId));
        },
        forGraph(graphId) {
            const set = byGraph.get(graphId);
            return set ? [...set] : [];
        },
        list() {
            return [...byKey.values()];
        },
    };
}

export function permissionCacheKey(toolName: string, signature?: string): string {
    return signature && signature.length > 0 ? `${toolName}::${signature}` : toolName;
}
