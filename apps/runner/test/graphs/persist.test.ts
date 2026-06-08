import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph, ScheduleRecurrence } from '@fabritorio/types';
import { applyGraphEdit, runtimeSignature } from '../../src/graphs/persist.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';

function scheduleGraph(overrides: { recurrence?: ScheduleRecurrence; at?: string }): Graph {
    return {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'l2',
        nodes: [
            {
                id: 'trg',
                type: 'trigger',
                position: { x: 0, y: 0 },
                trigger_kind: 'schedule',
                instructions: 'go',
                ...overrides,
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

describe('runtimeSignature: schedule-trigger fields', () => {
    it('changes when `recurrence` changes (PT15M → PT30M forces a runtime reload)', () => {
        const before = scheduleGraph({ recurrence: { kind: 'interval', every: 'PT15M' } });
        const after = scheduleGraph({ recurrence: { kind: 'interval', every: 'PT30M' } });
        expect(runtimeSignature(before)).not.toBe(runtimeSignature(after));
    });

    it('changes when the server-owned `stopped` flag toggles (re-evaluates liveness)', () => {
        const before = scheduleGraph({ recurrence: { kind: 'interval', every: 'PT15M' } });
        const after: Graph = { ...before, stopped: true };
        expect(runtimeSignature(before)).not.toBe(runtimeSignature(after));
    });
});

describe('applyGraphEdit: stopped carry-forward', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-persist-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('preserves a pre-set stopped flag across an FE-shaped edit', async () => {
        const store = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: (id) => store.get(id),
        });

        const seed = scheduleGraph({ recurrence: { kind: 'interval', every: 'PT15M' } });
        const created = await store.create({ ...seed, stopped: true });
        const id = created.id!;

        const { id: _id, created_at, updated_at, stopped: _stopped, ...rest } = created;
        void _id;
        void created_at;
        void updated_at;
        void _stopped;
        const fePayload = {
            ...rest,
            nodes: rest.nodes.map((n) =>
                n.id === 'trg' ? { ...n, position: { x: 10, y: 10 } } : n,
            ),
        };

        const result = await applyGraphEdit(store, runtimes, id, fePayload);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.graph.stopped).toBe(true);
        }
        const reread = await store.get(id);
        expect(reread?.stopped).toBe(true);
    });
});

describe('applyGraphEdit: syncPin on the save path', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-persist-syncpin-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('loads + pins a graph whose edit leaves it autonomous (unpaused Trigger)', async () => {
        const store = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: (id) => store.get(id),
        });

        const seed = scheduleGraph({ recurrence: { kind: 'interval', every: 'PT15M' } });
        const paused: Graph = {
            ...seed,
            nodes: seed.nodes.map((n) => (n.type === 'trigger' ? { ...n, paused: true } : n)),
        };
        const created = await store.create(paused);
        const id = created.id!;
        expect(runtimes.get(id)).toBeUndefined();

        const { id: _id, created_at, updated_at, stopped: _stopped, ...rest } = created;
        void _id;
        void created_at;
        void updated_at;
        void _stopped;
        const unpausedBody = {
            ...rest,
            nodes: rest.nodes.map((n) => (n.type === 'trigger' ? { ...n, paused: false } : n)),
        };

        const result = await applyGraphEdit(store, runtimes, id, unpausedBody);
        expect(result.ok).toBe(true);
        expect(runtimes.get(id)).toBeDefined();
        await runtimes.sweepNow();
        expect(runtimes.get(id)).toBeDefined();
    });

    it('unpins a graph whose edit pauses its last Trigger', async () => {
        const store = createGraphStore({ dir });
        const bus = createEventBus();
        const nodes = createNodeRegistry();
        const runtimes = createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: (id) => store.get(id),
            idleTtlMs: -1, // any idle gap exceeds TTL → reap an unpinned graph on demand
        });

        const seed = scheduleGraph({ recurrence: { kind: 'interval', every: 'PT15M' } });
        const created = await store.create(seed);
        const id = created.id!;
        await runtimes.syncPin(created);
        expect(runtimes.get(id)).toBeDefined();

        const { id: _id, created_at, updated_at, stopped: _stopped, ...rest } = created;
        void _id;
        void created_at;
        void updated_at;
        void _stopped;
        const pausedBody = {
            ...rest,
            nodes: rest.nodes.map((n) => (n.type === 'trigger' ? { ...n, paused: true } : n)),
        };

        const result = await applyGraphEdit(store, runtimes, id, pausedBody);
        expect(result.ok).toBe(true);
        await runtimes.sweepNow();
        expect(runtimes.get(id)).toBeUndefined();
    });
});
