import type { ObservabilityEvent } from '@fabritorio/types';

type Listener = (e: ObservabilityEvent) => void;

const listeners = new Set<Listener>();

export function publishLiveEvent(e: ObservabilityEvent): void {
    for (const l of listeners) l(e);
}

export function subscribeLiveEvents(l: Listener): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function subscribeNodeEvents(nodeId: string, listener: Listener): () => void {
    return subscribeLiveEvents((e) => {
        if (e.node_id === nodeId) listener(e);
    });
}
