import { describe, it, expect } from 'vitest';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import { createEventBus } from '../../src/runtime/event-bus.js';

function dispatch(eventId: string): DispatchEvent {
    return {
        eventId,
        source: 'test',
        timestamp: 0,
        messages: [{ role: 'user', content: 'hi' }],
    };
}

function chunk(eventId: string, parentId?: string): ObservabilityEvent {
    return {
        type: 'llm.chunk',
        ts: new Date().toISOString(),
        eventId,
        ...(parentId ? { parentId } : {}),
        node_id: 'm1',
        delta: 'hi',
    };
}

describe('createEventBus', () => {
    it('subscribers receive subsequent dispatches', () => {
        const bus = createEventBus();
        const received: DispatchEvent[] = [];
        bus.subscribeDispatch((e) => received.push(e));
        const ev = dispatch('r1');
        bus.emitDispatch(ev);
        expect(received).toEqual([ev]);
    });

    it('eventsByDispatch returns dispatches and observability records in order', () => {
        const bus = createEventBus();
        const a = dispatch('a');
        const obs = chunk('a', 'a');
        const c = dispatch('b');
        bus.emitDispatch(a);
        bus.emitDispatch(c);
        bus.emitObservability(obs);
        expect(bus.eventsByDispatch('a')).toEqual([a, obs]);
        expect(bus.eventsByDispatch('b')).toEqual([c]);
        expect(bus.eventsByDispatch('never')).toEqual([]);
    });

    it('subscribers registered after emission see nothing prior', () => {
        const bus = createEventBus();
        bus.emitDispatch(dispatch('a'));
        const received: DispatchEvent[] = [];
        bus.subscribeDispatch((e) => received.push(e));
        expect(received).toEqual([]);
    });

    it('unsubscribe stops delivery', () => {
        const bus = createEventBus();
        const received: DispatchEvent[] = [];
        const off = bus.subscribeDispatch((e) => received.push(e));
        bus.emitDispatch(dispatch('1'));
        off();
        bus.emitDispatch(dispatch('2'));
        expect(received).toHaveLength(1);
    });

    it('forgetDispatch drops the in-memory partition without affecting subscribers', () => {
        const bus = createEventBus();
        const received: DispatchEvent[] = [];
        bus.subscribeDispatch((e) => received.push(e));
        bus.emitDispatch(dispatch('a'));
        bus.forgetDispatch('a');
        expect(bus.eventsByDispatch('a')).toEqual([]);
        expect(received).toHaveLength(1);
    });

    it('publish delivers to topic subscribers and topics() reflects registration', async () => {
        const bus = createEventBus();
        const received: DispatchEvent[] = [];
        const off = bus.subscribeTopic('edge-1', (e) => {
            received.push(e);
        });
        expect(bus.topics()).toEqual(['edge-1']);
        const ev = dispatch('a');
        await bus.publish('edge-1', ev);
        expect(received).toEqual([ev]);
        off();
        expect(bus.topics()).toEqual([]);
    });

    it('rootEventIdsBySource indexes only root Dispatches in arrival order', () => {
        const bus = createEventBus();
        const root1: DispatchEvent = {
            eventId: 'r1',
            source: 'webchat:c1',
            timestamp: 1,
            messages: [{ role: 'user', content: 'a' }],
        };
        const root2: DispatchEvent = {
            eventId: 'r2',
            source: 'webchat:c1',
            timestamp: 2,
            messages: [{ role: 'user', content: 'b' }],
        };
        const child: DispatchEvent = {
            eventId: 'c1',
            parentId: 'r1',
            source: 'agent:ag1',
            timestamp: 3,
            messages: [{ role: 'assistant', content: 'hi' }],
        };
        bus.emitDispatch(root1);
        bus.emitDispatch(child);
        bus.emitDispatch(root2);
        expect(bus.rootEventIdsBySource('webchat:c1')).toEqual(['r1', 'r2']);
        expect(bus.rootEventIdsBySource('agent:ag1')).toEqual([]);
        expect(bus.rootEventIdsBySource('never')).toEqual([]);
    });

    it('hydrate fills byDispatch + source roots without firing listeners', () => {
        const bus = createEventBus();
        const dispatches: DispatchEvent[] = [];
        const observability: ObservabilityEvent[] = [];
        bus.subscribeDispatch((e) => dispatches.push(e));
        bus.subscribeObservability((e) => observability.push(e));
        const root: DispatchEvent = {
            eventId: 'r1',
            source: 'webchat:c1',
            timestamp: 1,
            messages: [{ role: 'user', content: 'hi' }],
        };
        const obs = chunk('r1', 'r1');
        bus.hydrate([root, obs]);
        expect(dispatches).toEqual([]);
        expect(observability).toEqual([]);
        expect(bus.eventsByDispatch('r1')).toEqual([root, obs]);
        expect(bus.rootEventIdsBySource('webchat:c1')).toEqual(['r1']);
    });

    it('rootEventIdsBySourcePrefix returns the union of every matching source key', () => {
        const bus = createEventBus();
        const r1: DispatchEvent = {
            eventId: 'r1',
            source: 'ask:a->b:r1',
            timestamp: 1,
            messages: [],
        };
        const r2: DispatchEvent = {
            eventId: 'r2',
            source: 'ask:a->c:r2',
            timestamp: 2,
            messages: [],
        };
        const r3: DispatchEvent = {
            eventId: 'r3',
            source: 'ask:z->a:r3',
            timestamp: 3,
            messages: [],
        };
        const r4: DispatchEvent = {
            eventId: 'r4',
            source: 'trigger:x',
            timestamp: 4,
            messages: [],
        };
        bus.emitDispatch(r1);
        bus.emitDispatch(r2);
        bus.emitDispatch(r3);
        bus.emitDispatch(r4);
        expect(bus.rootEventIdsBySourcePrefix('ask:a->').sort()).toEqual(['r1', 'r2']);
        expect(bus.rootEventIdsBySourcePrefix('').sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
        expect(bus.rootEventIdsBySourcePrefix('ask:nobody->')).toEqual([]);
    });

    it('allEvents is empty on a fresh bus', () => {
        const bus = createEventBus();
        expect(bus.allEvents()).toEqual([]);
    });

    it('allEvents preserves global insertion order across both kinds', () => {
        const bus = createEventBus();
        const a = dispatch('a');
        const obsA = chunk('a', 'a');
        const b = dispatch('b');
        const obsB = chunk('b', 'b');
        bus.emitDispatch(a);
        bus.emitObservability(obsA);
        bus.emitDispatch(b);
        bus.emitObservability(obsB);
        expect(bus.allEvents()).toEqual([a, obsA, b, obsB]);
    });

    it('allEvents push happens before listeners fire', () => {
        const bus = createEventBus();
        let snapshotAtFire: ReadonlyArray<DispatchEvent | ObservabilityEvent> = [];
        const ev = dispatch('a');
        bus.subscribeDispatch(() => {
            snapshotAtFire = [...bus.allEvents()];
        });
        bus.emitDispatch(ev);
        expect(snapshotAtFire).toEqual([ev]);
    });

    it('hydrate populates allEvents in seeded order, and subsequent emits append', () => {
        const bus = createEventBus();
        const r1: DispatchEvent = {
            eventId: 'r1',
            source: 's',
            timestamp: 1,
            messages: [{ role: 'user', content: 'a' }],
        };
        const obs1 = chunk('r1', 'r1');
        const r2: DispatchEvent = {
            eventId: 'r2',
            source: 's',
            timestamp: 2,
            messages: [{ role: 'user', content: 'b' }],
        };
        bus.hydrate([r1, obs1, r2]);
        expect(bus.allEvents()).toEqual([r1, obs1, r2]);
        const obs2 = chunk('r2', 'r2');
        bus.emitObservability(obs2);
        expect(bus.allEvents()).toEqual([r1, obs1, r2, obs2]);
    });

    it('forgetDispatch leaves allEvents intact (allEvents is the global history)', () => {
        const bus = createEventBus();
        const a = dispatch('a');
        const obsA = chunk('a', 'a');
        bus.emitDispatch(a);
        bus.emitObservability(obsA);
        bus.forgetDispatch('a');
        expect(bus.eventsByDispatch('a')).toEqual([]);
        expect(bus.allEvents()).toEqual([a, obsA]);
    });

    it('hydrate is idempotent on duplicate root ids', () => {
        const bus = createEventBus();
        const root: DispatchEvent = {
            eventId: 'r1',
            source: 's',
            timestamp: 1,
            messages: [],
        };
        bus.hydrate([root]);
        bus.hydrate([root]);
        expect(bus.rootEventIdsBySource('s')).toEqual(['r1']);
    });
});
