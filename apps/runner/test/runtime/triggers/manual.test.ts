import { describe, it, expect } from 'vitest';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { createEventBus } from '../../../src/runtime/event-bus.js';
import {
    createGraphRuntimeRegistry,
    createNodeRegistry,
} from '../../../src/runtime/graph-runtime.js';
import { createTriggerBinding } from '../../../src/runtime/bindings/trigger.js';
import {
    createTriggerStrategyRegistry,
    type TriggerStrategyRegistry,
} from '../../../src/runtime/triggers/strategy.js';
import { createManualStrategyFactory } from '../../../src/runtime/triggers/manual.js';
import {
    createManualTriggerRegistry,
    type ManualTriggerRegistry,
} from '../../../src/runtime/triggers/manual-registry.js';

const GRAPH_ID = '33333333-3333-4333-8333-333333333333';

function manualToSinkGraph(opts: { instructions?: string; paused?: boolean }): Graph {
    return {
        id: GRAPH_ID,
        kind: 'l2',
        nodes: [
            {
                id: 'trg',
                type: 'trigger',
                position: { x: 0, y: 0 },
                trigger_kind: 'manual',
                ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
                ...(opts.paused !== undefined ? { paused: opts.paused } : {}),
            },
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

function buildRegistry(manual: ManualTriggerRegistry): TriggerStrategyRegistry {
    const reg = createTriggerStrategyRegistry();
    reg.register('manual', createManualStrategyFactory({ registry: manual }));
    return reg;
}

describe('manual Trigger strategy', () => {
    it('registers the trigger on activate and unregisters on deactivate — arming no timer', async () => {
        const bus = createEventBus();
        const manual = createManualTriggerRegistry();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(manual) }));
        nodes.register('native_agent', { receiver: () => () => undefined });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(manualToSinkGraph({ instructions: 'do the thing' }));

        expect(manual.list().map((t) => t.nodeId)).toEqual(['trg']);
        expect(manual.get('trg')).toBeDefined();

        await loaded.unload();
        expect(manual.list()).toEqual([]);
        expect(manual.get('trg')).toBeUndefined();
    });

    it('a paused manual trigger never registers (binding short-circuits before the strategy)', async () => {
        const bus = createEventBus();
        const manual = createManualTriggerRegistry();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(manual) }));
        nodes.register('native_agent', { receiver: () => () => undefined });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(
            manualToSinkGraph({ instructions: 'do the thing', paused: true }),
        );

        expect(loaded.sources.has('trg')).toBe(false);
        expect(manual.list()).toEqual([]);

        await loaded.unload();
    });

    it('firing via the registry emits one DispatchEvent fanned out on the outgoing edges', async () => {
        const bus = createEventBus();
        const manual = createManualTriggerRegistry();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(manual) }));
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(manualToSinkGraph({ instructions: 'do the thing' }));

        const trigger = manual.get('trg')!;
        const event = await trigger.fire({ source: 'manual:trg' });
        await new Promise((r) => setImmediate(r));

        expect(event).not.toBeNull();
        expect(inbox).toHaveLength(1);
        expect(inbox[0]!.eventId).toBe(event!.eventId);
        expect(inbox[0]!.source).toBe('manual:trg');
        expect(inbox[0]!.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
        expect(inbox[0]!.parentId).toBeUndefined();
    });

    it('a per-fire message overrides the stored instructions fallback', async () => {
        const bus = createEventBus();
        const manual = createManualTriggerRegistry();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(manual) }));
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(manualToSinkGraph({ instructions: 'stored prompt' }));

        await manual.get('trg')!.fire({ source: 'manual:trg', message: 'override prompt' });
        await new Promise((r) => setImmediate(r));

        expect(inbox).toHaveLength(1);
        expect(inbox[0]!.messages).toEqual([{ role: 'user', content: 'override prompt' }]);
    });

    it('firing with no instructions and no message is a no-op returning null', async () => {
        const bus = createEventBus();
        const manual = createManualTriggerRegistry();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(manual) }));
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(manualToSinkGraph({}));

        const event = await manual.get('trg')!.fire({ source: 'manual:trg' });
        await new Promise((r) => setImmediate(r));

        expect(event).toBeNull();
        expect(inbox).toHaveLength(0);
    });

    it('register throws on a duplicate nodeId', () => {
        const manual = createManualTriggerRegistry();
        const fire = async () => null;
        manual.register({ nodeId: 'dup', fire });
        expect(() => manual.register({ nodeId: 'dup', fire })).toThrow(/already registered/);
    });
});
