import type { NodeBinding } from '../graph-runtime.js';
import {
    createPermissionGateRegistry,
    permissionCacheKey,
    type PermissionDecisionRequest,
    type PermissionGateHandle,
    type PermissionGateRegistry,
} from '../permission.js';

export interface PermissionBindingDeps {
    registry?: PermissionGateRegistry;
}

export interface PermissionBindingResult {
    binding: NodeBinding;
    registry: PermissionGateRegistry;
}

interface PendingEntry {
    resolve: (decision: 'allow' | 'deny') => void;
    meta: PermissionDecisionRequest;
    cacheKey: string;
}

export function getOrCreatePermissionGate(
    registry: PermissionGateRegistry,
    graphId: string,
    nodeId: string,
): PermissionGateHandle {
    const existing = registry.get(graphId, nodeId);
    if (existing) return existing;

    const pendingByCallId = new Map<string, PendingEntry>();
    const allowAlways = new Set<string>();
    const subs = new Set<(req: PermissionDecisionRequest) => void>();
    const closers = new Set<() => void>();

    const handle: PermissionGateHandle = {
        graphId,
        nodeId,
        async evaluate(call) {
            const key = permissionCacheKey(call.tool_name, call.signature);
            if (allowAlways.has(key)) return 'allow';
            const existing = pendingByCallId.get(call.call_id);
            if (existing) {
                return new Promise((resolve) => {
                    const prevResolve = existing.resolve;
                    existing.resolve = (d) => {
                        prevResolve(d);
                        resolve(d);
                    };
                });
            }
            const meta: PermissionDecisionRequest = {
                permissionNodeId: nodeId,
                callId: call.call_id,
                toolName: call.tool_name,
                args: call.args,
                ...(call.signature ? { argSignature: call.signature } : {}),
                ts: new Date().toISOString(),
            };
            return new Promise<'allow' | 'deny'>((resolve) => {
                pendingByCallId.set(call.call_id, { resolve, meta, cacheKey: key });
                for (const sub of subs) {
                    try {
                        sub(meta);
                    } catch {
                        /* best-effort */
                    }
                }
            });
        },
        pending() {
            return [...pendingByCallId.values()].map((e) => e.meta);
        },
        decide(callId, decision) {
            const entry = pendingByCallId.get(callId);
            if (!entry) return false;
            pendingByCallId.delete(callId);
            if (decision === 'allow-always') {
                allowAlways.add(entry.cacheKey);
                entry.resolve('allow');
            } else if (decision === 'allow-once') {
                entry.resolve('allow');
            } else {
                entry.resolve('deny');
            }
            return true;
        },
        subscribe(listener) {
            subs.add(listener);
            return () => {
                subs.delete(listener);
            };
        },
        onTeardown(closer) {
            closers.add(closer);
            return () => {
                closers.delete(closer);
            };
        },
        teardown() {
            for (const entry of pendingByCallId.values()) {
                try {
                    entry.resolve('deny');
                } catch {
                    /* best-effort */
                }
            }
            pendingByCallId.clear();
            for (const closer of closers) {
                try {
                    closer();
                } catch {
                    /* best-effort */
                }
            }
            closers.clear();
            subs.clear();
        },
    };

    registry.register(handle);
    return handle;
}

export function createPermissionBinding(deps: PermissionBindingDeps = {}): PermissionBindingResult {
    const registry = deps.registry ?? createPermissionGateRegistry();

    const binding: NodeBinding = {
        activate(ctx) {
            if (ctx.node.type !== 'permission') return null;
            if (!ctx.graph.id) {
                throw new Error('permission node requires a graph.id');
            }
            getOrCreatePermissionGate(registry, ctx.graph.id, ctx.node.id);
            return null;
        },
    };

    return { binding, registry };
}
