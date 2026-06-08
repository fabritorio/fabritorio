import type { ObservabilityEvent } from '@fabritorio/types';

export type DebugProbePhase = 'pre' | 'post';

export interface DebugProbeHaltEvent {
    probeNodeId: string;
    attachedTo: string;
    phase: DebugProbePhase;
    eventId: string;
    observabilityType: ObservabilityEvent['type'];
    ts: string;
}

export interface DebugProbeHandle {
    graphId: string;
    nodeId: string;
    attachedTo: string | undefined;
    haltOn: 'pre' | 'post' | 'both';
    enabled: boolean;
    awaitHalt(args: {
        nodeId: string;
        phase: DebugProbePhase;
        eventId: string;
        observabilityType: ObservabilityEvent['type'];
    }): Promise<void>;
    resume(): void;
    setEnabled(enabled: boolean): void;
    pending(): DebugProbeHaltEvent | null;
    subscribe(listener: (ev: DebugProbeHaltEvent) => void): () => void;
    onTeardown(closer: () => void): () => void;
    teardown(): void;
}

export interface DebugProbeRegistry {
    register(handle: DebugProbeHandle): void;
    unregister(graphId: string, nodeId: string): void;
    get(graphId: string, nodeId: string): DebugProbeHandle | undefined;
    forGraph(graphId: string): DebugProbeHandle[];
    list(): DebugProbeHandle[];
}

export function debugProbeKey(graphId: string, nodeId: string): string {
    return `${graphId}:${nodeId}`;
}

export function createDebugProbeRegistry(): DebugProbeRegistry {
    const byKey = new Map<string, DebugProbeHandle>();
    const byGraph = new Map<string, Set<DebugProbeHandle>>();
    return {
        register(handle) {
            const key = debugProbeKey(handle.graphId, handle.nodeId);
            if (byKey.has(key)) {
                throw new Error(`debug_probe ${key} is already registered`);
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
            const key = debugProbeKey(graphId, nodeId);
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
            return byKey.get(debugProbeKey(graphId, nodeId));
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

export function probeMatchesPhase(
    haltOn: 'pre' | 'post' | 'both',
    phase: DebugProbePhase,
): boolean {
    if (haltOn === 'both') return true;
    return haltOn === phase;
}

export function phaseForObservability(type: ObservabilityEvent['type']): DebugProbePhase | null {
    switch (type) {
        case 'gateway.received':
        case 'llm.request':
        case 'tool.called':
            return 'pre';
        case 'output.emitted':
        case 'llm.response':
        case 'tool.result':
            return 'post';
        default:
            return null;
    }
}
