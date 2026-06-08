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
import {
    createCronStrategyFactory,
    type Scheduler,
    type SchedulerHandle,
} from '../../../src/runtime/triggers/cron.js';

const GRAPH_ID = '22222222-2222-4222-8222-222222222222';

interface FakeScheduler extends Scheduler {
    tickAll(): void;
    active(): Array<{ expression: string }>;
}

function createFakeScheduler(): FakeScheduler {
    const jobs: Array<{ expression: string; callback: () => void; live: boolean }> = [];
    return {
        schedule(expression, callback) {
            const entry = { expression, callback, live: true };
            jobs.push(entry);
            const handle: SchedulerHandle = {
                stop() {
                    entry.live = false;
                },
            };
            return handle;
        },
        tickAll() {
            for (const job of jobs) {
                if (job.live) job.callback();
            }
        },
        active() {
            return jobs.filter((j) => j.live).map((j) => ({ expression: j.expression }));
        },
    };
}

function triggerToSinkGraph(opts: { expression?: string; instructions?: string }): Graph {
    return {
        id: GRAPH_ID,
        kind: 'l2',
        nodes: [
            {
                id: 'trg',
                type: 'trigger',
                position: { x: 0, y: 0 },
                trigger_kind: 'cron',
                ...(opts.expression !== undefined ? { expression: opts.expression } : {}),
                ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
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

function buildRegistry(scheduler: Scheduler): TriggerStrategyRegistry {
    const reg = createTriggerStrategyRegistry();
    reg.register('cron', createCronStrategyFactory({ scheduler }));
    return reg;
}

describe('cron Trigger strategy', () => {
    it('schedules a job on activate and fires a Dispatch each tick with the static instructions', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(scheduler) }));

        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(
            triggerToSinkGraph({
                expression: '*/5 * * * *',
                instructions: 'Summarize last 5 minutes of activity',
            }),
        );

        expect(scheduler.active()).toEqual([{ expression: '*/5 * * * *' }]);
        expect(inbox).toHaveLength(0);

        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));

        expect(inbox).toHaveLength(1);
        expect(inbox[0]!.source).toBe('trigger:trg');
        expect(inbox[0]!.messages).toEqual([
            { role: 'user', content: 'Summarize last 5 minutes of activity' },
        ]);
        expect(inbox[0]!.parentId).toBeUndefined();

        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(2);
        expect(inbox[0]!.eventId).not.toBe(inbox[1]!.eventId);

        await loaded.unload();
        expect(scheduler.active()).toEqual([]);
    });

    it('skips firing when no instructions and no per-fire override (no-op trigger)', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(scheduler) }));
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(triggerToSinkGraph({ expression: '* * * * *' }));

        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(0);
    });

    it('rejects activation when the cron expression is missing or empty', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(scheduler) }));
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });

        await expect(runtimes.load(triggerToSinkGraph({ instructions: 'go' }))).rejects.toThrow(
            /cron expression is required/,
        );
    });

    it('throws when no strategy is registered for the trigger kind', async () => {
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: createTriggerStrategyRegistry() }),
        );
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });

        await expect(
            runtimes.load(triggerToSinkGraph({ expression: '* * * * *', instructions: 'go' })),
        ).rejects.toThrow(/no strategy registered for kind "cron"/);
    });

    it('deactivate() stops the scheduler so post-unload ticks are inert', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: buildRegistry(scheduler) }));
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(
            triggerToSinkGraph({ expression: '* * * * *', instructions: 'go' }),
        );

        await loaded.unload();
        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(0);
    });
});
