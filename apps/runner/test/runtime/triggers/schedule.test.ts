import { describe, it, expect } from 'vitest';
import type { DispatchEvent, Graph, TriggerNode } from '@fabritorio/types';
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
import type {
    IntervalScheduler,
    Scheduler,
    SchedulerHandle,
} from '../../../src/runtime/triggers/cron.js';
import {
    compileEveryToCron,
    createScheduleStrategyFactory,
} from '../../../src/runtime/triggers/schedule.js';

const GRAPH_ID = '33333333-3333-4333-8333-333333333333';

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

interface FakeIntervalScheduler extends IntervalScheduler {
    tickAll(): void;
    active(): Array<{ ms: number }>;
}

function createFakeIntervalScheduler(): FakeIntervalScheduler {
    const jobs: Array<{ ms: number; callback: () => void; live: boolean }> = [];
    return {
        schedule(ms, callback) {
            const entry = { ms, callback, live: true };
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
            return jobs.filter((j) => j.live).map((j) => ({ ms: j.ms }));
        },
    };
}

function scheduleTriggerGraph(extras: Partial<TriggerNode>): Graph {
    return {
        id: GRAPH_ID,
        kind: 'l2',
        nodes: [
            {
                id: 'trg',
                type: 'trigger',
                position: { x: 0, y: 0 },
                trigger_kind: 'schedule',
                instructions: 'go',
                ...extras,
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

function buildRegistry(
    scheduler: Scheduler,
    intervalScheduler: IntervalScheduler,
): TriggerStrategyRegistry {
    const reg = createTriggerStrategyRegistry();
    reg.register('schedule', createScheduleStrategyFactory({ scheduler, intervalScheduler }));
    return reg;
}

describe('schedule Trigger strategy', () => {
    it('one-shot `at`: forwards the ISO timestamp to the cron scheduler and fires once on tick', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(scheduleTriggerGraph({ at: '2030-01-01T12:00:00Z' }));

        expect(scheduler.active()).toEqual([{ expression: '2030-01-01T12:00:00Z' }]);
        expect(intervalScheduler.active()).toEqual([]);

        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(1);
        expect(inbox[0]!.source).toBe('trigger:trg');
        expect(inbox[0]!.messages).toEqual([{ role: 'user', content: 'go' }]);

        await loaded.unload();
        expect(scheduler.active()).toEqual([]);
    });

    it('one-shot `at` already in the past: skips `scheduler.schedule` silently', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });

        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await runtimes.load(scheduleTriggerGraph({ at: past }));

        expect(scheduler.active()).toEqual([]);
        expect(intervalScheduler.active()).toEqual([]);
        expect(inbox).toHaveLength(0);
    });

    it('recurring `PT15M`: takes the cron path with `*/15 * * * *`', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(
            scheduleTriggerGraph({ recurrence: { kind: 'interval', every: 'PT15M' } }),
        );

        expect(scheduler.active()).toEqual([{ expression: '*/15 * * * *' }]);
        expect(intervalScheduler.active()).toEqual([]);

        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(1);
    });

    it('recurring `PT7M`: takes the interval path with 420000ms', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(
            scheduleTriggerGraph({ recurrence: { kind: 'interval', every: 'PT7M' } }),
        );

        expect(scheduler.active()).toEqual([]);
        expect(intervalScheduler.active()).toEqual([{ ms: 7 * 60 * 1000 }]);

        intervalScheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(1);
    });

    it('recurring `P1D`: takes the cron path with `0 0 * * *`', async () => {
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        nodes.register('native_agent', { receiver: () => () => undefined });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(
            scheduleTriggerGraph({ recurrence: { kind: 'interval', every: 'P1D' } }),
        );

        expect(scheduler.active()).toEqual([{ expression: '0 0 * * *' }]);
        expect(intervalScheduler.active()).toEqual([]);
    });

    it('recurring `PT30S`: sub-minute cadence routes through the interval path', async () => {
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        nodes.register('native_agent', { receiver: () => () => undefined });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(
            scheduleTriggerGraph({ recurrence: { kind: 'interval', every: 'PT30S' } }),
        );

        expect(scheduler.active()).toEqual([]);
        expect(intervalScheduler.active()).toEqual([{ ms: 30000 }]);
    });

    it('window: ticks before `from` and after `until` are inert; ticks inside the window fire', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });

        const now = Date.now();
        const future = new Date(now + 60 * 60 * 1000).toISOString();
        const farFuture = new Date(now + 2 * 60 * 60 * 1000).toISOString();
        await runtimes.load(
            scheduleTriggerGraph({
                recurrence: { kind: 'interval', every: 'PT15M' },
                from: future,
                until: farFuture,
            }),
        );

        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(0);

        const past = new Date(now - 2 * 60 * 60 * 1000).toISOString();
        const recentPast = new Date(now - 60 * 60 * 1000).toISOString();
        const sched2 = createFakeScheduler();
        const interval2 = createFakeIntervalScheduler();
        const nodes2 = createNodeRegistry();
        const inbox2: DispatchEvent[] = [];
        nodes2.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(sched2, interval2) }),
        );
        nodes2.register('native_agent', {
            receiver: () => (event) => {
                inbox2.push(event);
            },
        });
        const runtimes2 = createGraphRuntimeRegistry({ bus: createEventBus(), nodes: nodes2 });
        await runtimes2.load(
            scheduleTriggerGraph({
                recurrence: { kind: 'interval', every: 'PT15M' },
                from: past,
                until: recentPast,
            }),
        );
        sched2.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox2).toHaveLength(0);

        const sched3 = createFakeScheduler();
        const interval3 = createFakeIntervalScheduler();
        const nodes3 = createNodeRegistry();
        const inbox3: DispatchEvent[] = [];
        nodes3.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(sched3, interval3) }),
        );
        nodes3.register('native_agent', {
            receiver: () => (event) => {
                inbox3.push(event);
            },
        });
        const runtimes3 = createGraphRuntimeRegistry({ bus: createEventBus(), nodes: nodes3 });
        await runtimes3.load(
            scheduleTriggerGraph({ recurrence: { kind: 'interval', every: 'PT15M' } }),
        );
        sched3.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox3).toHaveLength(1);
    });

    it('recurring daily `{time:"09:30"}`: compiles to cron `30 9 * * *`', async () => {
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        nodes.register('native_agent', { receiver: () => () => undefined });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(scheduleTriggerGraph({ recurrence: { kind: 'daily', time: '09:30' } }));

        expect(scheduler.active()).toEqual([{ expression: '30 9 * * *' }]);
        expect(intervalScheduler.active()).toEqual([]);
    });

    it('recurring weekly `{time:"09:30", days:[1,3,5]}`: compiles to cron `30 9 * * 1,3,5`', async () => {
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        nodes.register('native_agent', { receiver: () => () => undefined });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await runtimes.load(
            scheduleTriggerGraph({
                recurrence: { kind: 'weekly', time: '09:30', days: [1, 3, 5] },
            }),
        );

        expect(scheduler.active()).toEqual([{ expression: '30 9 * * 1,3,5' }]);
        expect(intervalScheduler.active()).toEqual([]);
    });

    it('rejects activation when neither `at` nor `recurrence` is set', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        await expect(runtimes.load(scheduleTriggerGraph({}))).rejects.toThrow(
            /schedule requires `at` or `recurrence`/,
        );
    });

    it('rejects activation when mounted on the wrong `trigger_kind`', () => {
        const factory = createScheduleStrategyFactory({
            scheduler: createFakeScheduler(),
            intervalScheduler: createFakeIntervalScheduler(),
        });
        expect(() =>
            factory({
                nodeId: 'trg',
                node: {
                    id: 'trg',
                    type: 'trigger',
                    position: { x: 0, y: 0 },
                    trigger_kind: 'cron',
                    expression: '* * * * *',
                } as TriggerNode,
                fire: async () => undefined,
            }),
        ).toThrow(/schedule strategy: trigger trg has kind="cron"/);
    });

    it('deactivate() stops the underlying handle so post-unload ticks are inert', async () => {
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();
        const nodes = createNodeRegistry();
        nodes.register(
            'trigger',
            createTriggerBinding({ strategies: buildRegistry(scheduler, intervalScheduler) }),
        );
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });
        const loaded = await runtimes.load(
            scheduleTriggerGraph({ recurrence: { kind: 'interval', every: 'PT15M' } }),
        );

        await loaded.unload();
        scheduler.tickAll();
        await new Promise((r) => setImmediate(r));
        expect(inbox).toHaveLength(0);
        expect(scheduler.active()).toEqual([]);
    });
});

describe('compileEveryToCron', () => {
    it('returns null for sub-minute cadences', () => {
        expect(compileEveryToCron(1)).toBeNull();
        expect(compileEveryToCron(30)).toBeNull();
        expect(compileEveryToCron(59)).toBeNull();
    });

    it('maps clean minute divisors of 60 to `*/N * * * *`', () => {
        expect(compileEveryToCron(60)).toBe('* * * * *');
        expect(compileEveryToCron(120)).toBe('*/2 * * * *');
        expect(compileEveryToCron(180)).toBe('*/3 * * * *');
        expect(compileEveryToCron(240)).toBe('*/4 * * * *');
        expect(compileEveryToCron(300)).toBe('*/5 * * * *');
        expect(compileEveryToCron(360)).toBe('*/6 * * * *');
        expect(compileEveryToCron(600)).toBe('*/10 * * * *');
        expect(compileEveryToCron(720)).toBe('*/12 * * * *');
        expect(compileEveryToCron(900)).toBe('*/15 * * * *');
        expect(compileEveryToCron(1200)).toBe('*/20 * * * *');
        expect(compileEveryToCron(1800)).toBe('*/30 * * * *');
    });

    it('returns null for minute cadences that do not divide 60 cleanly', () => {
        expect(compileEveryToCron(7 * 60)).toBeNull();
        expect(compileEveryToCron(45 * 60)).toBeNull();
        expect(compileEveryToCron(35 * 60)).toBeNull();
        expect(compileEveryToCron(90)).toBeNull();
    });

    it('maps clean hour divisors of 24 to `0 */N * * *` (and `0 * * * *` for 1h)', () => {
        expect(compileEveryToCron(3600)).toBe('0 * * * *');
        expect(compileEveryToCron(7200)).toBe('0 */2 * * *');
        expect(compileEveryToCron(3 * 3600)).toBe('0 */3 * * *');
        expect(compileEveryToCron(4 * 3600)).toBe('0 */4 * * *');
        expect(compileEveryToCron(6 * 3600)).toBe('0 */6 * * *');
        expect(compileEveryToCron(8 * 3600)).toBe('0 */8 * * *');
        expect(compileEveryToCron(12 * 3600)).toBe('0 */12 * * *');
    });

    it('returns null for hour cadences that do not divide 24 cleanly', () => {
        expect(compileEveryToCron(5 * 3600)).toBeNull();
        expect(compileEveryToCron(7 * 3600)).toBeNull();
        expect(compileEveryToCron(3600 + 1800)).toBeNull();
    });

    it('maps a single day to `0 0 * * *`', () => {
        expect(compileEveryToCron(86400)).toBe('0 0 * * *');
    });

    it('returns null for multi-day cadences (interval path)', () => {
        expect(compileEveryToCron(2 * 86400)).toBeNull();
        expect(compileEveryToCron(7 * 86400)).toBeNull();
    });
});
