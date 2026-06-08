import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { checkTopology, topologyMessage } from '../../src/graphs/invariant.js';
import { inject } from '../helpers/inject.js';

describe('save-time 1:1 invariant (Step 5)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-invariant-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('clean POST passes when the ref is unused elsewhere', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const handler = await graphStore.create({
                kind: 'handler',
                nodes: [],
                edges: [],
            });

            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l1',
                    name: 'fresh',
                    nodes: [
                        {
                            id: 'h',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            ref_id: handler.id,
                        },
                    ],
                    edges: [],
                },
            });
            expect(create.statusCode).toBe(201);
        } finally {
            await app.close();
        }
    });

    it('rejects a POST that reuses a ref_id already held by another graph', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const handler = await graphStore.create({
                kind: 'handler',
                nodes: [],
                edges: [],
            });
            const first = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l1',
                    nodes: [
                        {
                            id: 'h',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            ref_id: handler.id,
                        },
                    ],
                    edges: [],
                },
            });
            expect(first.statusCode).toBe(201);
            const firstGraph = (first.json() as { graph: Graph }).graph;

            const second = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l1',
                    nodes: [
                        {
                            id: 'h',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            ref_id: handler.id,
                        },
                    ],
                    edges: [],
                },
            });
            expect(second.statusCode).toBe(409);
            const body = second.json() as {
                error: string;
                conflicts: Array<{
                    refId: string;
                    otherGraphId: string;
                    otherNodeId: string;
                }>;
            };
            expect(body.conflicts).toHaveLength(1);
            expect(body.conflicts[0]?.refId).toBe(handler.id);
            expect(body.conflicts[0]?.otherGraphId).toBe(firstGraph.id);
            expect(body.conflicts[0]?.otherNodeId).toBe('h');
            expect(body.error).toContain(handler.id!);
        } finally {
            await app.close();
        }
    });

    it("PUT replaces the existing graph's own refs without false conflict", async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const handler = await graphStore.create({
                kind: 'handler',
                nodes: [],
                edges: [],
            });
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l1',
                    name: 'before',
                    nodes: [
                        {
                            id: 'h',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            ref_id: handler.id,
                        },
                    ],
                    edges: [],
                },
            });
            expect(create.statusCode).toBe(201);
            const id = (create.json() as { graph: Graph }).graph.id!;

            const put = await inject(app, {
                method: 'PUT',
                url: `/api/graphs/${id}`,
                payload: {
                    kind: 'l1',
                    name: 'after',
                    nodes: [
                        {
                            id: 'h',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            ref_id: handler.id,
                        },
                    ],
                    edges: [],
                },
            });
            expect(put.statusCode).toBe(200);
            expect((put.json() as { graph: Graph }).graph.name).toBe('after');
        } finally {
            await app.close();
        }
    });

    it('rejects a POST that puts the same ref on two of its own nodes', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const handler = await graphStore.create({
                kind: 'handler',
                nodes: [],
                edges: [],
            });
            const create = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l1',
                    nodes: [
                        {
                            id: 'h1',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            ref_id: handler.id,
                        },
                        {
                            id: 'h2',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            ref_id: handler.id,
                        },
                    ],
                    edges: [],
                },
            });
            expect(create.statusCode).toBe(409);
        } finally {
            await app.close();
        }
    });
});

describe('topology invariant: Channel↔Agent 1:1 + Trigger→Agent (Step 4)', () => {
    const channel = (id: string) =>
        ({
            id,
            type: 'channel' as const,
            position: { x: 0, y: 0 },
            channel_kind: 'webchat' as const,
        }) satisfies Graph['nodes'][number];
    const nativeAgent = (id: string) =>
        ({
            id,
            type: 'native_agent' as const,
            position: { x: 0, y: 0 },
            l1_graph_id: '00000000-0000-0000-0000-000000000000',
        }) satisfies Graph['nodes'][number];
    const cliAgent = (id: string) =>
        ({
            id,
            type: 'cli_agent' as const,
            position: { x: 0, y: 0 },
            command: 'echo',
            session_mode: 'stateless' as const,
        }) satisfies Graph['nodes'][number];
    const trigger = (id: string) =>
        ({
            id,
            type: 'trigger' as const,
            position: { x: 0, y: 0 },
            trigger_kind: 'manual' as const,
        }) satisfies Graph['nodes'][number];
    const memory = (id: string) =>
        ({
            id,
            type: 'memory' as const,
            position: { x: 0, y: 0 },
            storage: 'in_memory' as const,
            storage_kind: 'kv' as const,
            handling: 'full_history' as const,
            tool_access: 'none' as const,
        }) satisfies Graph['nodes'][number];
    const edge = (id: string, src: string, tgt: string) => ({
        id,
        source: { node_id: src },
        target: { node_id: tgt },
    });

    it('accepts a Channel with multiple agent neighbours (multiplicity rule deferred)', () => {
        const result = checkTopology({
            nodes: [channel('c1'), channel('c2'), nativeAgent('a1')],
            edges: [edge('e1', 'c1', 'a1'), edge('e2', 'a1', 'c2')],
        });
        expect(result.ok).toBe(true);
    });

    it('rejects a Trigger that is the target of an event-flow edge from an Agent', () => {
        const result = checkTopology({
            nodes: [trigger('t1'), nativeAgent('a1')],
            edges: [edge('e1', 'a1', 't1')],
        });
        expect(result.ok).toBe(false);
        const violation = result.violations.find((v) => v.code === 'trigger_inbound_from_agent');
        expect(violation).toBeDefined();
        expect(violation?.nodeId).toBe('t1');
        expect(violation?.message).toContain('t1');
        expect(violation?.message).toContain('a1');
    });

    it('accepts a 1:1 Channel↔Agent with both directions wired', () => {
        const result = checkTopology({
            nodes: [channel('c1'), nativeAgent('a1')],
            edges: [edge('e1', 'c1', 'a1'), edge('e2', 'a1', 'c1')],
        });
        expect(result.ok).toBe(true);
        expect(result.violations).toHaveLength(0);
    });

    it('accepts a 1:1 Channel→Agent with only the inbound direction (no reply edge)', () => {
        const result = checkTopology({
            nodes: [channel('c1'), nativeAgent('a1')],
            edges: [edge('e1', 'c1', 'a1')],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts Agent↔Agent fan-out (no channel-1:1 restriction on agent-to-agent edges)', () => {
        const result = checkTopology({
            nodes: [
                nativeAgent('orchestrator'),
                nativeAgent('coder'),
                nativeAgent('reviewer'),
                cliAgent('bash'),
            ],
            edges: [
                edge('e1', 'orchestrator', 'coder'),
                edge('e2', 'orchestrator', 'reviewer'),
                edge('e3', 'orchestrator', 'bash'),
                edge('e4', 'coder', 'reviewer'),
                edge('e5', 'reviewer', 'orchestrator'),
            ],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts a Trigger fanning out to many Agents', () => {
        const result = checkTopology({
            nodes: [trigger('t1'), nativeAgent('a1'), nativeAgent('a2'), cliAgent('a3')],
            edges: [edge('e1', 't1', 'a1'), edge('e2', 't1', 'a2'), edge('e3', 't1', 'a3')],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts a Trigger→single Agent', () => {
        const result = checkTopology({
            nodes: [trigger('t1'), nativeAgent('a1')],
            edges: [edge('e1', 't1', 'a1')],
        });
        expect(result.ok).toBe(true);
    });

    it('does not penalize reference wires (Memory→Agent) — they are not event-flow', () => {
        const result = checkTopology({
            nodes: [channel('c1'), nativeAgent('a1'), memory('m1')],
            edges: [edge('e1', 'c1', 'a1'), edge('e2', 'm1', 'a1')],
        });
        expect(result.ok).toBe(true);
    });

    it('ignores edges that reference unknown nodes', () => {
        const result = checkTopology({
            nodes: [channel('c1')],
            edges: [edge('e1', 'c1', 'ghost-agent')],
        });
        expect(result.ok).toBe(true);
    });
});

describe('topology invariant: schedule-trigger configuration', () => {
    const scheduleTrigger = (id: string, extras: Record<string, unknown>) =>
        ({
            id,
            type: 'trigger' as const,
            position: { x: 0, y: 0 },
            trigger_kind: 'schedule' as const,
            ...extras,
        }) as Graph['nodes'][number];

    it('accepts a one-shot `at` schedule', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { at: '2026-06-01T15:00:00Z' })],
            edges: [],
        });
        expect(result.ok).toBe(true);
        expect(result.violations).toHaveLength(0);
    });

    it('accepts a recurring interval schedule', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { recurrence: { kind: 'interval', every: 'PT15M' } })],
            edges: [],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts a daily cadence with a valid `time`', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { recurrence: { kind: 'daily', time: '09:30' } })],
            edges: [],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts a weekly cadence with a valid `time` and `days`', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    recurrence: { kind: 'weekly', time: '09:30', days: [1, 3, 5] },
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts a recurring schedule with a valid `from`/`until` window', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    recurrence: { kind: 'interval', every: 'PT15M' },
                    from: '2026-06-01T00:00:00Z',
                    until: '2026-06-02T00:00:00Z',
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts compound interval durations like `PT1H30M`', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { recurrence: { kind: 'interval', every: 'PT1H30M' } })],
            edges: [],
        });
        expect(result.ok).toBe(true);
    });

    it('rejects a schedule that sets neither `at` nor `recurrence`', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', {})],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_missing_at_or_recurrence');
        expect(v).toBeDefined();
        expect(v?.nodeId).toBe('t1');
    });

    it('rejects a schedule that sets both `at` and `recurrence`', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    at: '2026-06-01T15:00:00Z',
                    recurrence: { kind: 'interval', every: 'PT15M' },
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_both_at_and_recurrence');
        expect(v).toBeDefined();
    });

    it('rejects a gibberish `at` value that is not ISO-8601', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { at: 'tomorrow' })],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_invalid_at');
        expect(v).toBeDefined();
        expect(v?.message).toContain('tomorrow');
    });

    it('rejects a date-only `at` without the `T` separator', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { at: '2026-06-01' })],
            edges: [],
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.code === 'schedule_invalid_at')).toBe(true);
    });

    it('rejects a gibberish interval `every` value', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', { recurrence: { kind: 'interval', every: '15 minutes' } }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_invalid_every');
        expect(v).toBeDefined();
    });

    it('rejects interval `every: "P"` with no components', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { recurrence: { kind: 'interval', every: 'P' } })],
            edges: [],
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.code === 'schedule_invalid_every')).toBe(true);
    });

    it('rejects interval `every: "PT0S"` below the 1-second floor', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { recurrence: { kind: 'interval', every: 'PT0S' } })],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_invalid_every');
        expect(v).toBeDefined();
        expect(v?.message).toContain('1 second');
    });

    it('rejects a daily cadence with a malformed `time`', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { recurrence: { kind: 'daily', time: '9:30' } })],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_invalid_time');
        expect(v).toBeDefined();
    });

    it('rejects a daily cadence with an out-of-range `time`', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { recurrence: { kind: 'daily', time: '24:00' } })],
            edges: [],
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.code === 'schedule_invalid_time')).toBe(true);
    });

    it('rejects a weekly cadence with no `days`', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', { recurrence: { kind: 'weekly', time: '09:30', days: [] } }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_invalid_days');
        expect(v).toBeDefined();
    });

    it('rejects a weekly cadence with an out-of-range weekday', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    recurrence: { kind: 'weekly', time: '09:30', days: [1, 7] },
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.code === 'schedule_invalid_days')).toBe(true);
    });

    it('rejects a window where `from >= until`', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    recurrence: { kind: 'interval', every: 'PT15M' },
                    from: '2026-06-02T00:00:00Z',
                    until: '2026-06-01T00:00:00Z',
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_window_misordered');
        expect(v).toBeDefined();
    });

    it('rejects a window when `from == until`', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    recurrence: { kind: 'interval', every: 'PT15M' },
                    from: '2026-06-01T00:00:00Z',
                    until: '2026-06-01T00:00:00Z',
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.code === 'schedule_window_misordered')).toBe(true);
    });

    it('rejects `from` set alongside `at` (windowing a one-shot)', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    at: '2026-06-01T15:00:00Z',
                    from: '2026-06-01T00:00:00Z',
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const v = result.violations.find((x) => x.code === 'schedule_window_without_recurrence');
        expect(v).toBeDefined();
    });

    it('rejects `until` set alongside `at`', () => {
        const result = checkTopology({
            nodes: [
                scheduleTrigger('t1', {
                    at: '2026-06-01T15:00:00Z',
                    until: '2026-06-02T00:00:00Z',
                }),
            ],
            edges: [],
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.code === 'schedule_window_without_recurrence')).toBe(
            true,
        );
    });

    it('ignores schedule-only fields on a non-schedule trigger', () => {
        const result = checkTopology({
            nodes: [
                {
                    id: 't1',
                    type: 'trigger',
                    position: { x: 0, y: 0 },
                    trigger_kind: 'cron',
                    expression: '*/5 * * * *',
                    at: 'whatever',
                    recurrence: { kind: 'interval', every: 'not-a-duration' },
                    from: 'also-garbage',
                } as Graph['nodes'][number],
            ],
            edges: [],
        });
        expect(result.ok).toBe(true);
    });

    it('topologyMessage names the schedule violation', () => {
        const result = checkTopology({
            nodes: [scheduleTrigger('t1', { at: 'tomorrow' })],
            edges: [],
        });
        expect(result.ok).toBe(false);
        const msg = topologyMessage(result.violations);
        expect(msg).toContain('t1');
        expect(msg).toContain('tomorrow');
    });
});

describe('topology invariant — HTTP route mapping (Step 4)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-topology-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('POST /graphs with a 1:1 Channel↔Agent passes the topology check', async () => {
        const graphStore = createGraphStore({ dir });
        const app = buildServer({ logger: false, graphStore });
        try {
            const res = await inject(app, {
                method: 'POST',
                url: '/api/graphs',
                payload: {
                    kind: 'l2',
                    nodes: [
                        {
                            id: 'c1',
                            type: 'channel',
                            position: { x: 0, y: 0 },
                            channel_kind: 'webchat',
                        },
                        {
                            id: 'a1',
                            type: 'cli_agent',
                            position: { x: 0, y: 0 },
                            command: 'echo',
                            session_mode: 'stateless',
                        },
                    ],
                    edges: [{ id: 'e1', source: { node_id: 'c1' }, target: { node_id: 'a1' } }],
                },
            });
            expect(res.statusCode).toBe(201);
        } finally {
            await app.close();
        }
    });
});
