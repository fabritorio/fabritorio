import { EventEmitter } from 'node:events';
import type { DispatchEvent, EdgeTraversedEvent, ObservabilityEvent } from '@fabritorio/types';

export type DispatchListener = (event: DispatchEvent, seq?: number) => void | Promise<void>;
export type ObservabilityListener = (event: ObservabilityEvent, seq: number) => void;
export type TraversalListener = (event: EdgeTraversedEvent) => void;

export interface EventBus {
    emitDispatch(event: DispatchEvent): void;
    emitObservability(event: ObservabilityEvent): void;
    subscribeDispatch(listener: DispatchListener): () => void;
    subscribeObservability(listener: ObservabilityListener): () => void;
    emitTraversal(event: EdgeTraversedEvent): void;
    subscribeTraversal(listener: TraversalListener): () => void;
    eventsByDispatch(eventId: string): Array<DispatchEvent | ObservabilityEvent>;
    allEvents(): ReadonlyArray<DispatchEvent | ObservabilityEvent>;
    forgetDispatch(eventId: string): void;
    publish(topic: string, event: DispatchEvent): Promise<void>;
    subscribeTopic(topic: string, listener: DispatchListener): () => void;
    topics(): string[];
    rootEventIdsBySource(source: string): string[];
    rootEventIdsBySourcePrefix(prefix: string): string[];
    hydrate(events: Array<DispatchEvent | ObservabilityEvent>): void;
}

function isDispatchEvent(event: DispatchEvent | ObservabilityEvent): event is DispatchEvent {
    return !('type' in event) && typeof (event as DispatchEvent).timestamp === 'number';
}

export function createEventBus(): EventBus {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    const byDispatch = new Map<string, Array<DispatchEvent | ObservabilityEvent>>();
    const allEventsArr: Array<DispatchEvent | ObservabilityEvent> = [];
    const topicSubs = new Map<string, Set<DispatchListener>>();
    const rootsBySource = new Map<string, string[]>();
    const seenRoots = new Set<string>();

    function appendByDispatch(event: DispatchEvent | ObservabilityEvent): number {
        let list = byDispatch.get(event.eventId);
        if (!list) {
            list = [];
            byDispatch.set(event.eventId, list);
        }
        list.push(event);
        allEventsArr.push(event);
        return allEventsArr.length - 1;
    }

    function indexRoot(event: DispatchEvent): void {
        if (event.parentId) return;
        if (seenRoots.has(event.eventId)) return;
        seenRoots.add(event.eventId);
        let roots = rootsBySource.get(event.source);
        if (!roots) {
            roots = [];
            rootsBySource.set(event.source, roots);
        }
        roots.push(event.eventId);
    }

    function recordDispatch(event: DispatchEvent): number {
        const seq = appendByDispatch(event);
        indexRoot(event);
        return seq;
    }

    function recordObservability(event: ObservabilityEvent): number {
        return appendByDispatch(event);
    }

    return {
        emitDispatch(event) {
            const seq = recordDispatch(event);
            emitter.emit('dispatch', event, seq);
        },
        emitObservability(event) {
            const seq = recordObservability(event);
            emitter.emit('observability', event, seq);
        },
        subscribeDispatch(listener) {
            emitter.on('dispatch', listener);
            return () => {
                emitter.off('dispatch', listener);
            };
        },
        subscribeObservability(listener) {
            emitter.on('observability', listener);
            return () => {
                emitter.off('observability', listener);
            };
        },
        emitTraversal(event) {
            emitter.emit('traversal', event);
        },
        subscribeTraversal(listener) {
            emitter.on('traversal', listener);
            return () => {
                emitter.off('traversal', listener);
            };
        },
        eventsByDispatch(eventId) {
            const list = byDispatch.get(eventId);
            return list ? [...list] : [];
        },
        allEvents() {
            return allEventsArr;
        },
        forgetDispatch(eventId) {
            byDispatch.delete(eventId);
        },
        async publish(topic, event) {
            const subs = topicSubs.get(topic);
            if (!subs || subs.size === 0) return;
            await Promise.all([...subs].map((sub) => sub(event)));
        },
        subscribeTopic(topic, listener) {
            let subs = topicSubs.get(topic);
            if (!subs) {
                subs = new Set();
                topicSubs.set(topic, subs);
            }
            subs.add(listener);
            return () => {
                const set = topicSubs.get(topic);
                if (!set) return;
                set.delete(listener);
                if (set.size === 0) topicSubs.delete(topic);
            };
        },
        topics() {
            return [...topicSubs.keys()];
        },
        rootEventIdsBySource(source) {
            return [...(rootsBySource.get(source) ?? [])];
        },
        rootEventIdsBySourcePrefix(prefix) {
            const out: string[] = [];
            for (const [source, ids] of rootsBySource) {
                if (!source.startsWith(prefix)) continue;
                for (const id of ids) out.push(id);
            }
            return out;
        },
        hydrate(events) {
            for (const event of events) {
                if (isDispatchEvent(event)) {
                    recordDispatch(event);
                } else {
                    recordObservability(event);
                }
            }
        },
    };
}
