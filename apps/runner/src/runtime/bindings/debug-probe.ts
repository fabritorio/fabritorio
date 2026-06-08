import type { DebugProbeNode, ObservabilityEvent } from '@fabritorio/types';
import type { NodeBinding } from '../graph-runtime.js';
import {
    createDebugProbeRegistry,
    phaseForObservability,
    probeMatchesPhase,
    type DebugProbeHaltEvent,
    type DebugProbeHandle,
    type DebugProbePhase,
    type DebugProbeRegistry,
} from '../debug-probe.js';

export interface DebugProbeBindingDeps {
    registry?: DebugProbeRegistry;
}

export interface DebugProbeBindingResult {
    binding: NodeBinding;
    registry: DebugProbeRegistry;
}

export function createDebugProbeBinding(deps: DebugProbeBindingDeps = {}): DebugProbeBindingResult {
    const registry = deps.registry ?? createDebugProbeRegistry();

    const binding: NodeBinding = {
        activate(ctx) {
            if (ctx.node.type !== 'debug_probe') return null;
            if (!ctx.graph.id) {
                throw new Error('debug_probe requires a graph.id');
            }
            const probeNode = ctx.node as DebugProbeNode;
            const graphId = ctx.graph.id;
            const nodeId = probeNode.id;

            if (probeNode.attachedTo && probeNode.attachedTo.length > 0) {
                const existing = registry.forGraph(graphId);
                for (const other of existing) {
                    if (other.attachedTo === probeNode.attachedTo) {
                        throw new Error(
                            `debug_probe ${nodeId}: another probe (${other.nodeId}) is already attached to ${probeNode.attachedTo}`,
                        );
                    }
                }
            }

            let pendingResolve: (() => void) | null = null;
            let pendingMeta: DebugProbeHaltEvent | null = null;
            const subs = new Set<(ev: DebugProbeHaltEvent) => void>();
            const closers = new Set<() => void>();

            const handle: DebugProbeHandle = {
                graphId,
                nodeId,
                attachedTo: probeNode.attachedTo,
                haltOn: probeNode.haltOn ?? 'both',
                enabled: probeNode.enabled !== false,
                async awaitHalt(args) {
                    if (!handle.enabled) return;
                    if (!handle.attachedTo) return;
                    if (args.nodeId !== handle.attachedTo) return;
                    if (!probeMatchesPhase(handle.haltOn, args.phase)) return;
                    if (pendingResolve) return;

                    const meta: DebugProbeHaltEvent = {
                        probeNodeId: handle.nodeId,
                        attachedTo: handle.attachedTo,
                        phase: args.phase,
                        eventId: args.eventId,
                        observabilityType: args.observabilityType,
                        ts: new Date().toISOString(),
                    };
                    pendingMeta = meta;
                    // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: a subscriber may (un)subscribe during dispatch; iterate a copy, not the live Set
                    for (const sub of [...subs]) {
                        try {
                            sub(meta);
                        } catch {
                            // best-effort; a misbehaving subscriber doesn't poison others
                        }
                    }
                    await new Promise<void>((resolve) => {
                        pendingResolve = resolve;
                    });
                    pendingResolve = null;
                    pendingMeta = null;
                },
                resume() {
                    const r = pendingResolve;
                    pendingResolve = null;
                    pendingMeta = null;
                    if (r) r();
                },
                setEnabled(enabled) {
                    handle.enabled = enabled;
                    if (!enabled) {
                        const r = pendingResolve;
                        pendingResolve = null;
                        pendingMeta = null;
                        if (r) r();
                    }
                },
                pending() {
                    return pendingMeta;
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
                    const r = pendingResolve;
                    pendingResolve = null;
                    pendingMeta = null;
                    if (r) r();
                    for (const closer of closers) {
                        try {
                            closer();
                        } catch {
                            /* best-effort socket close */
                        }
                    }
                    closers.clear();
                    subs.clear();
                },
            };

            registry.register(handle);
            return {
                deactivate() {
                    handle.teardown();
                    registry.unregister(graphId, nodeId);
                },
            };
        },
    };

    return { binding, registry };
}

export async function awaitProbesFor(
    probes: ReadonlyArray<DebugProbeHandle>,
    args: {
        nodeId: string;
        eventId: string;
        phase?: DebugProbePhase;
        observabilityType?: ObservabilityEvent['type'];
    },
): Promise<void> {
    if (probes.length === 0) return;
    const phase: DebugProbePhase | null =
        args.phase ??
        (args.observabilityType ? phaseForObservability(args.observabilityType) : null);
    if (!phase) return;
    const obsType: ObservabilityEvent['type'] =
        args.observabilityType ?? (phase === 'pre' ? 'gateway.received' : 'output.emitted');
    await Promise.all(
        probes.map((p) =>
            p.awaitHalt({
                nodeId: args.nodeId,
                phase,
                eventId: args.eventId,
                observabilityType: obsType,
            }),
        ),
    );
}
