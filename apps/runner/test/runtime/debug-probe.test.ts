import { describe, it, expect } from 'vitest';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { awaitProbesFor, createDebugProbeBinding } from '../../src/runtime/bindings/debug-probe.js';
import {
    createDebugProbeRegistry,
    type DebugProbeRegistry,
} from '../../src/runtime/debug-probe.js';

const GRAPH_ID = '22222222-2222-4222-8222-222222222222';

function probedGraph(probe: {
    attachedTo?: string;
    haltOn?: 'pre' | 'post' | 'both';
    enabled?: boolean;
}): Graph {
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
            {
                id: 'probe-1',
                type: 'debug_probe',
                position: { x: 200, y: 0 },
                ...probe,
            },
        ],
        edges: [
            {
                id: 'e-out',
                source: { node_id: 'ch', port_id: 'out' },
                target: { node_id: 'ag', port_id: 'in' },
            },
        ],
    };
}

interface Boot {
    bus: ReturnType<typeof createEventBus>;
    registry: DebugProbeRegistry;
    agentInbox: DispatchEvent[];
    loaded: Awaited<ReturnType<ReturnType<typeof createGraphRuntimeRegistry>['load']>>;
}

async function boot(graph: Graph): Promise<Boot> {
    const bus = createEventBus();
    const registry = createDebugProbeRegistry();
    const nodes = createNodeRegistry();

    const agentInbox: DispatchEvent[] = [];
    nodes.register('native_agent', {
        receiver: () => async (event) => {
            await Promise.resolve();
            agentInbox.push(event);
        },
    });
    nodes.register('channel', {});
    const { binding: probeBinding } = createDebugProbeBinding({ registry });
    nodes.register('debug_probe', probeBinding);

    const runtimes = createGraphRuntimeRegistry({
        bus,
        nodes,
        awaitProbe: (args) => awaitProbesFor(registry.forGraph(args.graphId), args),
    });
    const loaded = await runtimes.load(graph);
    return { bus, registry, agentInbox, loaded };
}

function dispatchEvent(eventId: string): DispatchEvent {
    return {
        eventId,
        source: 'test',
        timestamp: 0,
        messages: [{ role: 'user', content: 'hi' }],
    };
}

describe('DebugProbe', () => {
    it('halts pre-receiver when attached to the destination node, resumes on demand', async () => {
        const { bus, registry, agentInbox, loaded } = await boot(
            probedGraph({ attachedTo: 'ag', haltOn: 'pre' }),
        );

        const handle = registry.get(GRAPH_ID, 'probe-1');
        expect(handle).toBeDefined();
        expect(handle?.attachedTo).toBe('ag');

        const ev = dispatchEvent('ev-1');
        const settled = bus.publish('e-out', ev);

        await Promise.resolve();
        await Promise.resolve();
        expect(agentInbox).toHaveLength(0);
        expect(handle?.pending()).not.toBeNull();
        expect(handle?.pending()?.phase).toBe('pre');

        handle?.resume();
        await settled;
        expect(agentInbox).toHaveLength(1);
        expect(agentInbox[0]?.eventId).toBe('ev-1');
        expect(handle?.pending()).toBeNull();

        await loaded.unload();
    });

    it('disable bypasses the halt entirely', async () => {
        const { bus, registry, agentInbox, loaded } = await boot(
            probedGraph({ attachedTo: 'ag', haltOn: 'both', enabled: false }),
        );

        const handle = registry.get(GRAPH_ID, 'probe-1');
        expect(handle?.enabled).toBe(false);

        const ev = dispatchEvent('ev-1');
        await bus.publish('e-out', ev);
        expect(agentInbox).toHaveLength(1);
        expect(handle?.pending()).toBeNull();

        await loaded.unload();
    });

    it('halts post-phase when haltOn=post (after the receiver returns)', async () => {
        const { bus, registry, agentInbox, loaded } = await boot(
            probedGraph({ attachedTo: 'ag', haltOn: 'post' }),
        );
        const handle = registry.get(GRAPH_ID, 'probe-1');

        const settled = bus.publish('e-out', dispatchEvent('ev-2'));
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
        expect(agentInbox).toHaveLength(1);
        expect(handle?.pending()?.phase).toBe('post');

        handle?.resume();
        await settled;
        expect(handle?.pending()).toBeNull();
        await loaded.unload();
    });

    it('rejects a second probe attached to the same target', async () => {
        const bus = createEventBus();
        const registry = createDebugProbeRegistry();
        const nodes = createNodeRegistry();
        nodes.register('native_agent', { receiver: () => () => {} });
        nodes.register('channel', {});
        const { binding } = createDebugProbeBinding({ registry });
        nodes.register('debug_probe', binding);
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });

        const conflictGraph: Graph = {
            id: GRAPH_ID,
            kind: 'l2',
            nodes: [
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: '00000000-0000-4000-8000-000000000000',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'probe-a',
                    type: 'debug_probe',
                    attachedTo: 'ag',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'probe-b',
                    type: 'debug_probe',
                    attachedTo: 'ag',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        };
        await expect(runtimes.load(conflictGraph)).rejects.toThrow(/already attached/);
    });

    it('teardown releases an in-flight halt so the runtime can unload', async () => {
        const { bus, registry, loaded } = await boot(
            probedGraph({ attachedTo: 'ag', haltOn: 'pre' }),
        );
        const handle = registry.get(GRAPH_ID, 'probe-1');

        const settled = bus.publish('e-out', dispatchEvent('ev-3'));
        await Promise.resolve();
        await Promise.resolve();
        expect(handle?.pending()).not.toBeNull();

        await loaded.unload();
        await settled;
    });
});
