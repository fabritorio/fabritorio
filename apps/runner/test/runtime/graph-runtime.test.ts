import { describe, it, expect } from 'vitest';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';

const GRAPH_ID = '11111111-1111-4111-8111-111111111111';

function chatGraph(): Graph {
    return {
        id: GRAPH_ID,
        kind: 'l2',
        nodes: [
            {
                id: 'ch',
                type: 'channel',
                channel_kind: 'webchat',
                position: { x: 0, y: 0 },
            },
            {
                id: 'ag',
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 100, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-out',
                source: { node_id: 'ch', port_id: 'out' },
                target: { node_id: 'ag', port_id: 'in' },
            },
            {
                id: 'e-in',
                source: { node_id: 'ag', port_id: 'out' },
                target: { node_id: 'ch', port_id: 'in' },
            },
        ],
    };
}

describe('graph-runtime registry', () => {
    it('loads with idle→running transition and unloads back to idle', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });

        const loaded = await runtimes.load(chatGraph());
        expect(loaded.status).toBe('running');
        expect(loaded.subscriptions).toEqual([]);

        await loaded.unload();
        expect(loaded.status).toBe('idle');
        expect(runtimes.get(GRAPH_ID)).toBeUndefined();
    });

    it('source→sink wiring: registered receivers see events published on edge topics', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const received: DispatchEvent[] = [];

        nodes.register('native_agent', {
            receiver: () => (event) => {
                received.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(chatGraph());

        expect(loaded.subscriptions).toContain('e-out');

        const event: DispatchEvent = {
            eventId: 'ev-1',
            source: 'test',
            timestamp: 0,
            messages: [{ role: 'user', content: 'hi' }],
        };
        await bus.publish('e-out', event);
        expect(received).toEqual([event]);

        await loaded.unload();
        expect(bus.topics()).toEqual([]);
    });

    it('activate hooks fire in load order and deactivate on unload', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const calls: string[] = [];

        nodes.register('channel', {
            activate: () => ({
                deactivate: () => {
                    calls.push('ch:deactivate');
                },
            }),
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(chatGraph());
        expect(loaded.sources.has('ch')).toBe(true);

        await loaded.unload();
        expect(calls).toEqual(['ch:deactivate']);
    });

    it('rejects loading the same graph twice', async () => {
        const bus = createEventBus();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes: createNodeRegistry(),
        });
        await runtimes.load(chatGraph());
        await expect(runtimes.load(chatGraph())).rejects.toThrow(/already loaded/);
    });

    it('projects per-node runtime state from gateway.received / output.emitted on the bus', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(chatGraph());
        expect(loaded.nodeStates.size).toBe(0);

        const snapshots: Array<readonly string[]> = [];
        const off = runtimes.subscribeNodeStates(GRAPH_ID, (next) =>
            snapshots.push([...next.keys()]),
        );

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-1',
            node_id: 'ag',
            type: 'gateway.received',
            source: 'test',
            messages: [],
        });
        expect(loaded.nodeStates.has('ag')).toBe(true);
        expect(loaded.nodeStates.get('ag')?.phase).toBe('running');
        expect(loaded.nodeStates.get('ag')?.dispatchEventId).toBe('ev-1');
        expect(loaded.nodeStates.get('ag')?.activeAsks).toEqual([]);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-1',
            node_id: 'l1-output-node',
            type: 'output.emitted',
            port: 'result',
            messages: [],
        });
        expect(loaded.nodeStates.size).toBe(0);

        expect(snapshots).toEqual([['ag'], []]);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-other',
            node_id: 'not-in-graph',
            type: 'gateway.received',
            source: 'test',
            messages: [],
        });
        expect(loaded.nodeStates.size).toBe(0);

        off();
        await loaded.unload();
    });

    it('flips phase to asking on outbound ask Dispatch and back on the callee output', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(chatGraph());

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-root',
            node_id: 'ag',
            type: 'gateway.received',
            source: 'test',
            messages: [],
        });
        expect(loaded.nodeStates.get('ag')?.phase).toBe('running');

        bus.emitDispatch({
            eventId: 'child-1',
            parentId: 'ev-root',
            source: 'ask:ag->callee:child-1',
            timestamp: 1234,
            messages: [{ role: 'user', content: 'brief' }],
            meta: {
                ask_call_id: 'ask-abc',
                ask_caller_node_id: 'ag',
                ask_callee_node_id: 'callee',
            },
        });
        const after = loaded.nodeStates.get('ag');
        expect(after?.phase).toBe('asking');
        expect(after?.activeAsks).toEqual([
            { askCallId: 'ask-abc', targetNodeId: 'callee', startedAt: 1234 },
        ]);

        bus.emitDispatch({
            eventId: 'child-1-reply',
            parentId: 'child-1',
            source: 'ask:ag->callee:child-1',
            timestamp: 1235,
            messages: [{ role: 'assistant', content: 'ok' }],
            meta: {
                ask_call_id: 'ask-abc',
                ask_caller_node_id: 'ag',
                ask_callee_node_id: 'callee',
                port: 'result',
            },
        });
        expect(loaded.nodeStates.get('ag')?.activeAsks).toHaveLength(1);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'child-1',
            node_id: 'callee-output',
            type: 'output.emitted',
            port: 'result',
            messages: [],
        });
        const closed = loaded.nodeStates.get('ag');
        expect(closed?.phase).toBe('running');
        expect(closed?.activeAsks).toEqual([]);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-root',
            node_id: 'l1-output-node',
            type: 'output.emitted',
            port: 'result',
            messages: [],
        });
        expect(loaded.nodeStates.has('ag')).toBe(false);

        await loaded.unload();
    });

    it('tracks concurrent asks and only flips phase back when all complete', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(chatGraph());

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-root',
            node_id: 'ag',
            type: 'gateway.received',
            source: 'test',
            messages: [],
        });

        bus.emitDispatch({
            eventId: 'child-a',
            parentId: 'ev-root',
            source: 'ask:ag->c1:child-a',
            timestamp: 1,
            messages: [],
            meta: {
                ask_call_id: 'ask-a',
                ask_caller_node_id: 'ag',
                ask_callee_node_id: 'c1',
            },
        });
        bus.emitDispatch({
            eventId: 'child-b',
            parentId: 'ev-root',
            source: 'ask:ag->c2:child-b',
            timestamp: 2,
            messages: [],
            meta: {
                ask_call_id: 'ask-b',
                ask_caller_node_id: 'ag',
                ask_callee_node_id: 'c2',
            },
        });
        expect(loaded.nodeStates.get('ag')?.activeAsks).toHaveLength(2);
        expect(loaded.nodeStates.get('ag')?.phase).toBe('asking');

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'child-a',
            node_id: 'l1-output',
            type: 'output.emitted',
            port: 'result',
            messages: [],
        });
        expect(loaded.nodeStates.get('ag')?.phase).toBe('asking');
        expect(loaded.nodeStates.get('ag')?.activeAsks).toEqual([
            { askCallId: 'ask-b', targetNodeId: 'c2', startedAt: 2 },
        ]);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'child-b',
            node_id: 'l1-output',
            type: 'output.emitted',
            port: 'result',
            messages: [],
        });
        expect(loaded.nodeStates.get('ag')?.phase).toBe('running');
        expect(loaded.nodeStates.get('ag')?.activeAsks).toEqual([]);

        await loaded.unload();
    });

    it('ask-callee terminating clears its OWN entry AND pops the caller ask (case a + b, not one)', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const graph: Graph = {
            id: GRAPH_ID,
            kind: 'l2',
            nodes: [
                { id: 'ag', type: 'native_agent', l1_graph_id: 'x', position: { x: 0, y: 0 } },
                { id: 'cl', type: 'native_agent', l1_graph_id: 'y', position: { x: 1, y: 0 } },
            ],
            edges: [
                {
                    id: 'ag->cl',
                    source: { node_id: 'ag', port_id: 'out' },
                    target: { node_id: 'cl', port_id: 'in' },
                },
            ],
        };
        const loaded = await runtimes.load(graph);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-root',
            node_id: 'ag',
            type: 'gateway.received',
            source: 'test',
            messages: [],
        });
        bus.emitDispatch({
            eventId: 'child-1',
            parentId: 'ev-root',
            source: 'ask:ag->cl:child-1',
            timestamp: 1,
            messages: [],
            meta: { ask_call_id: 'ask-1', ask_caller_node_id: 'ag', ask_callee_node_id: 'cl' },
        });
        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'child-1',
            node_id: 'cl',
            type: 'gateway.received',
            source: 'ask:ag->cl:child-1',
            messages: [],
        });
        expect(loaded.nodeStates.get('ag')?.phase).toBe('asking');
        expect(loaded.nodeStates.has('cl')).toBe(true);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'child-1',
            node_id: 'cl-output',
            type: 'output.emitted',
            port: 'result',
            messages: [],
        });
        expect(loaded.nodeStates.has('cl')).toBe(false);
        expect(loaded.nodeStates.get('ag')?.phase).toBe('running');
        expect(loaded.nodeStates.get('ag')?.activeAsks).toEqual([]);

        await loaded.unload();
    });

    it("chain.stopped clears a node's own entry and pops a correlated ask", async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(chatGraph());

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-root',
            node_id: 'ag',
            type: 'gateway.received',
            source: 'test',
            messages: [],
        });
        bus.emitDispatch({
            eventId: 'child-1',
            parentId: 'ev-root',
            source: 'ask:ag->callee:child-1',
            timestamp: 1,
            messages: [],
            meta: { ask_call_id: 'ask-1', ask_caller_node_id: 'ag', ask_callee_node_id: 'callee' },
        });
        expect(loaded.nodeStates.get('ag')?.phase).toBe('asking');

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'child-1',
            node_id: 'callee',
            type: 'chain.stopped',
            reason: 'dispatch terminated without output',
        });
        expect(loaded.nodeStates.get('ag')?.phase).toBe('running');
        expect(loaded.nodeStates.get('ag')?.activeAsks).toEqual([]);

        bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: 'ev-root',
            node_id: 'ag',
            type: 'chain.stopped',
            reason: 'cancelled',
        });
        expect(loaded.nodeStates.has('ag')).toBe(false);

        await loaded.unload();
    });

    it('ensureLoaded loads once and is idempotent on the second call', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        let getGraphCalls = 0;
        let activations = 0;
        nodes.register('channel', {
            activate: () => {
                activations++;
                return { deactivate: () => undefined };
            },
        });
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: async (id) => {
                getGraphCalls++;
                return id === GRAPH_ID ? chatGraph() : undefined;
            },
        });

        await runtimes.ensureLoaded(GRAPH_ID);
        expect(runtimes.get(GRAPH_ID)).toBeDefined();
        await runtimes.ensureLoaded(GRAPH_ID);
        expect(activations).toBe(1);
        expect(getGraphCalls).toBe(1);

        await runtimes.unload(GRAPH_ID);
    });

    it('ensureLoaded throws (and leaves no state) when the graph is missing', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: async () => undefined,
        });
        await expect(runtimes.ensureLoaded(GRAPH_ID)).rejects.toThrow(/not found/);
        expect(runtimes.get(GRAPH_ID)).toBeUndefined();
    });

    it('idle GC sweep unloads only when unpinned, quiescent, and past TTL', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: async () => chatGraph(),
            idleTtlMs: -1, // any positive idle gap exceeds TTL → reap on demand
        });

        await runtimes.ensureLoaded(GRAPH_ID);
        expect(runtimes.get(GRAPH_ID)).toBeDefined();
        await runtimes.sweepNow();
        expect(runtimes.get(GRAPH_ID)).toBeUndefined();
    });

    it('idle GC sweep never reaps a pinned (autonomous) graph', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const autonomous: Graph = {
            id: GRAPH_ID,
            kind: 'l2',
            nodes: [
                {
                    id: 'trig',
                    type: 'trigger',
                    trigger_kind: 'manual',
                    position: { x: 0, y: 0 },
                },
                { id: 'ag', type: 'native_agent', l1_graph_id: 'x', position: { x: 100, y: 0 } },
            ],
            edges: [
                {
                    id: 'e',
                    source: { node_id: 'trig', port_id: 'out' },
                    target: { node_id: 'ag', port_id: 'in' },
                },
            ],
        };
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: async () => autonomous,
            idleTtlMs: -1,
        });

        await runtimes.syncPin(autonomous);
        expect(runtimes.get(GRAPH_ID)).toBeDefined();
        await runtimes.sweepNow();
        expect(runtimes.get(GRAPH_ID)).toBeDefined();

        await runtimes.unload(GRAPH_ID);
    });

    it('syncPin loads+pins an autonomous graph and unpins a non-autonomous one', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const autonomous: Graph = {
            id: GRAPH_ID,
            kind: 'l2',
            nodes: [
                { id: 'trig', type: 'trigger', trigger_kind: 'manual', position: { x: 0, y: 0 } },
            ],
            edges: [],
        };
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: async () => autonomous,
            idleTtlMs: -1,
        });

        await runtimes.syncPin(autonomous);
        expect(runtimes.get(GRAPH_ID)).toBeDefined();
        await runtimes.sweepNow();
        expect(runtimes.get(GRAPH_ID)).toBeDefined();

        const paused: Graph = {
            ...autonomous,
            nodes: [{ ...autonomous.nodes[0]!, paused: true } as Graph['nodes'][number]],
        };
        await runtimes.syncPin(paused);
        await runtimes.sweepNow();
        expect(runtimes.get(GRAPH_ID)).toBeUndefined();
    });

    it('syncPin does not load (and unpins) a stopped autonomous graph', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const stopped: Graph = {
            id: GRAPH_ID,
            kind: 'l2',
            stopped: true,
            nodes: [
                { id: 'trig', type: 'trigger', trigger_kind: 'manual', position: { x: 0, y: 0 } },
            ],
            edges: [],
        };
        const runtimes = createGraphRuntimeRegistry({ bus, nodes, getGraph: async () => stopped });
        await runtimes.syncPin(stopped);
        expect(runtimes.get(GRAPH_ID)).toBeUndefined();
    });

    it('rejects edges that reference unknown nodes', async () => {
        const bus = createEventBus();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes: createNodeRegistry(),
        });
        const broken: Graph = {
            id: GRAPH_ID,
            kind: 'l2',
            nodes: [
                {
                    id: 'ch',
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [
                {
                    id: 'e1',
                    source: { node_id: 'ch' },
                    target: { node_id: 'ghost' },
                },
            ],
        };
        await expect(runtimes.load(broken)).rejects.toThrow(/unknown node/);
    });
});
