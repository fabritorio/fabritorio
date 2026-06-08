import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { buildServer } from '../src/server.js';
import { createGraphStore } from '../src/graphs/store.js';
import { createEventBus } from '../src/runtime/event-bus.js';
import {
    createGraphRuntimeRegistry,
    createNodeRegistry,
    graphIsAutonomous,
} from '../src/runtime/graph-runtime.js';
import { createTriggerBinding } from '../src/runtime/bindings/trigger.js';
import { createTriggerStrategyRegistry } from '../src/runtime/triggers/strategy.js';
import {
    createCronStrategyFactory,
    type IntervalScheduler,
    type Scheduler,
    type SchedulerHandle,
} from '../src/runtime/triggers/cron.js';
import { createScheduleStrategyFactory } from '../src/runtime/triggers/schedule.js';
import { inject } from './helpers/inject.js';

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

function createFakeIntervalScheduler(): IntervalScheduler {
    return {
        schedule() {
            return { stop() {} };
        },
    };
}

function scheduleTriggerGraph(): Graph {
    return {
        id: '44444444-4444-4444-8444-444444444444',
        kind: 'l2',
        nodes: [
            {
                id: 'trg',
                type: 'trigger',
                position: { x: 0, y: 0 },
                trigger_kind: 'schedule',
                recurrence: { kind: 'interval', every: 'PT15M' },
                instructions: 'Roll up the last 15 minutes',
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

describe('buildServer trigger wiring', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-server-trigger-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('schedule trigger: PT15M loaded through buildServer fires a Dispatch on tick', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();

        const triggerStrategies = createTriggerStrategyRegistry();
        triggerStrategies.register('cron', createCronStrategyFactory({ scheduler }));
        triggerStrategies.register(
            'schedule',
            createScheduleStrategyFactory({ scheduler, intervalScheduler }),
        );

        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: triggerStrategies }));
        const inbox: DispatchEvent[] = [];
        nodes.register('native_agent', {
            receiver: () => (event) => {
                inbox.push(event);
            },
        });
        const runtimes = createGraphRuntimeRegistry({ bus, nodes });

        const app = buildServer({
            logger: false,
            graphStore,
            bus,
            runtimes,
            nodes,
            triggerStrategies,
        });
        try {
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: scheduleTriggerGraph(),
            });
            expect(create.statusCode).toBe(201);
            const id = (create.json() as { graph: Graph }).graph.id!;

            const load = await inject(app, { method: 'POST', url: `/api/graphs/${id}/load` });
            expect(load.statusCode).toBe(200);

            expect(scheduler.active()).toEqual([{ expression: '*/15 * * * *' }]);
            expect(inbox).toHaveLength(0);

            scheduler.tickAll();
            await new Promise((r) => setImmediate(r));

            expect(inbox).toHaveLength(1);
            expect(inbox[0]!.source).toBe('trigger:trg');
            expect(inbox[0]!.messages).toEqual([
                { role: 'user', content: 'Roll up the last 15 minutes' },
            ]);
        } finally {
            await app.close();
        }
    });
});

describe('buildServer boot pin', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-server-bootpin-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function stoppedScheduleGraph(): Graph {
        return {
            id: '66666666-6666-4666-8666-666666666666',
            kind: 'l2',
            stopped: true,
            nodes: [
                {
                    id: 'trg',
                    type: 'trigger',
                    position: { x: 0, y: 0 },
                    trigger_kind: 'schedule',
                    recurrence: { kind: 'interval', every: 'PT15M' },
                    instructions: 'should not boot-pin (stopped)',
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

    it('pins+loads the autonomous graph and skips the stopped one', async () => {
        const graphStore = createGraphStore({ dir });
        const bus = createEventBus();
        const scheduler = createFakeScheduler();
        const intervalScheduler = createFakeIntervalScheduler();

        const triggerStrategies = createTriggerStrategyRegistry();
        triggerStrategies.register('cron', createCronStrategyFactory({ scheduler }));
        triggerStrategies.register(
            'schedule',
            createScheduleStrategyFactory({ scheduler, intervalScheduler }),
        );

        const nodes = createNodeRegistry();
        nodes.register('trigger', createTriggerBinding({ strategies: triggerStrategies }));
        nodes.register('native_agent', { receiver: () => () => {} });
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: (id) => graphStore.get(id),
            idleTtlMs: -1,
        });

        const autonomous = await graphStore.create(scheduleTriggerGraph());
        const stopped = await graphStore.create(stoppedScheduleGraph());

        const app = buildServer({
            logger: false,
            graphStore,
            bus,
            runtimes,
            nodes,
            triggerStrategies,
        });
        try {
            await app.bootstrapComplete;
            for (const g of await app.graphStore.list()) {
                if (!graphIsAutonomous(g) || g.stopped) continue;
                await app.runtimes.syncPin(g);
            }

            expect(runtimes.get(autonomous.id!)).toBeDefined();
            expect(scheduler.active()).toEqual([{ expression: '*/15 * * * *' }]);
            expect(runtimes.get(stopped.id!)).toBeUndefined();

            await runtimes.sweepNow();
            expect(runtimes.get(autonomous.id!)).toBeDefined();
            expect(runtimes.get(stopped.id!)).toBeUndefined();
        } finally {
            await app.close();
        }
    });
});
