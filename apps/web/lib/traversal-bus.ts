import type { EdgeTraversedEvent } from '@fabritorio/types';

type Listener = (e: EdgeTraversedEvent) => void;

const rawListeners = new Set<Listener>();
const byEdge = new Map<string, Set<Listener>>();

export function publishTraversal(e: EdgeTraversedEvent): void {
    for (const l of rawListeners) l(e);
}

export function subscribeTraversals(l: Listener): () => void {
    rawListeners.add(l);
    return () => {
        rawListeners.delete(l);
    };
}

export function deliverToEdge(e: EdgeTraversedEvent): void {
    const set = byEdge.get(e.edgeId);
    if (set) for (const l of set) l(e);
}

export function subscribeEdgeTraversals(edgeId: string, l: Listener): () => void {
    let set = byEdge.get(edgeId);
    if (!set) {
        set = new Set();
        byEdge.set(edgeId, set);
    }
    set.add(l);
    return () => {
        const s = byEdge.get(edgeId);
        if (!s) return;
        s.delete(l);
        if (s.size === 0) byEdge.delete(edgeId);
    };
}
