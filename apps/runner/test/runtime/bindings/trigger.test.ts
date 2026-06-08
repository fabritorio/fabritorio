import { describe, expect, it } from 'vitest';
import type { Graph, TriggerNode } from '@fabritorio/types';
import { createEventBus } from '../../../src/runtime/event-bus.js';
import {
    createGraphRuntimeRegistry,
    createNodeRegistry,
} from '../../../src/runtime/graph-runtime.js';
import { createTriggerBinding } from '../../../src/runtime/bindings/trigger.js';
import { createTriggerStrategyRegistry } from '../../../src/runtime/triggers/strategy.js';

const GRAPH_ID = '44444444-4444-4444-8444-444444444444';

function pausedTriggerGraph(node: Partial<TriggerNode>): Graph {
    return {
        id: GRAPH_ID,
        kind: 'l2',
        nodes: [
            {
                id: 'trg',
                type: 'trigger',
                position: { x: 0, y: 0 },
                trigger_kind: 'cron',
                expression: '* * * * *',
                ...node,
            } as TriggerNode,
            {
                id: 'ag',
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 200, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-fire',
                source: { node_id: 'trg', port_id: 'out' },
                target: { node_id: 'ag', port_id: 'in' },
            },
        ],
    };
}

describe('trigger binding — paused', () => {
    it('short-circuits activation when `paused === true` — no strategy lookup, no source handle', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const strategies = createTriggerStrategyRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies }));
        nodes.register('native_agent', { receiver: () => () => undefined });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(pausedTriggerGraph({ paused: true }));

        expect(loaded.sources.has('trg')).toBe(false);
        expect(loaded.sources.size).toBe(0);

        await loaded.unload();
    });

    it('falls through to the strategy lookup when `paused` is unset or false', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const strategies = createTriggerStrategyRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies }));
        nodes.register('native_agent', { receiver: () => () => undefined });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await expect(runtimes.load(pausedTriggerGraph({}))).rejects.toThrow(
            /no strategy registered for kind "cron"/,
        );
    });
});
