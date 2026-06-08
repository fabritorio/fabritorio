import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { inject } from '../helpers/inject.js';

const AGENT_ID = 'ag';
const CHANNEL_ID = 'ch';
const TRIGGER_ID = 'trg';

function idleGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'idle-graph',
        nodes: [
            { id: CHANNEL_ID, type: 'channel', channel_kind: 'webchat', position: { x: 0, y: 0 } },
            {
                id: AGENT_ID,
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 200, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-out',
                source: { node_id: CHANNEL_ID, port_id: 'out' },
                target: { node_id: AGENT_ID, port_id: 'in' },
            },
        ],
    };
}

function autonomousGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'autonomous-graph',
        nodes: [
            {
                id: TRIGGER_ID,
                type: 'trigger',
                trigger_kind: 'schedule',
                at: '2000-01-01T00:00:00Z',
                instructions: 'go',
                position: { x: 0, y: 0 },
            },
            {
                id: AGENT_ID,
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 200, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-trg-ag',
                source: { node_id: TRIGGER_ID, port_id: 'out' },
                target: { node_id: AGENT_ID, port_id: 'in' },
            },
        ],
    };
}

interface Boot {
    app: ReturnType<typeof buildServer>;
    cleanup(): Promise<void>;
}

function boot(dir: string): Boot {
    const graphStore = createGraphStore({ dir });
    const bus = createEventBus();
    const nodes = createNodeRegistry();
    nodes.register('trigger', { activate: () => null });
    nodes.register('native_agent', { receiver: () => () => undefined });
    nodes.register('channel', { receiver: () => () => undefined });
    const app = buildServer({ logger: false, graphStore, bus, nodes });
    return {
        app,
        async cleanup() {
            await app.close();
        },
    };
}

async function createGraph(
    app: Boot['app'],
    body: Omit<Graph, 'id' | 'created_at' | 'updated_at'>,
): Promise<string> {
    const res = await inject(app, { method: 'POST', url: '/api/graphs', payload: body });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
        throw new Error(`create failed: ${res.statusCode} ${res.body}`);
    }
    return (res.json() as { graph: Graph }).graph.id!;
}

async function statusOf(app: Boot['app'], id: string): Promise<string | undefined> {
    const res = await inject(app, { method: 'GET', url: '/api/graphs' });
    const graphs = (res.json() as { graphs: Array<{ id: string; status: string }> }).graphs;
    return graphs.find((g) => g.id === id)?.status;
}

describe('graph lifecycle routes', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-lifecycle-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('GET /graphs reports idle for a non-autonomous, unloaded graph', async () => {
        const b = boot(dir);
        try {
            const id = await createGraph(b.app, idleGraph());
            expect(await statusOf(b.app, id)).toBe('idle');
        } finally {
            await b.cleanup();
        }
    });

    it('activate loads an idle graph → GET /graphs shows running; activate is idempotent', async () => {
        const b = boot(dir);
        try {
            const id = await createGraph(b.app, idleGraph());
            const act = await inject(b.app, { method: 'POST', url: `/api/graphs/${id}/activate` });
            expect(act.statusCode).toBe(200);
            expect((act.json() as { status: string }).status).toBe('running');
            expect(await statusOf(b.app, id)).toBe('running');

            const again = await inject(b.app, {
                method: 'POST',
                url: `/api/graphs/${id}/activate`,
            });
            expect(again.statusCode).toBe(200);
            expect(await statusOf(b.app, id)).toBe('running');
        } finally {
            await b.cleanup();
        }
    });

    it('activate 404s for a missing graph', async () => {
        const b = boot(dir);
        try {
            const missing = '99999999-9999-4999-8999-999999999999';
            const res = await inject(b.app, {
                method: 'POST',
                url: `/api/graphs/${missing}/activate`,
            });
            expect(res.statusCode).toBe(404);
        } finally {
            await b.cleanup();
        }
    });

    it('stop persists stopped, unloads, and GET /graphs shows stopped', async () => {
        const b = boot(dir);
        try {
            const id = await createGraph(b.app, idleGraph());
            await inject(b.app, { method: 'POST', url: `/api/graphs/${id}/activate` });
            expect(await statusOf(b.app, id)).toBe('running');

            const stop = await inject(b.app, { method: 'POST', url: `/api/graphs/${id}/stop` });
            expect(stop.statusCode).toBe(200);
            expect((stop.json() as { status: string }).status).toBe('stopped');
            expect(await statusOf(b.app, id)).toBe('stopped');
            const got = await inject(b.app, { method: 'GET', url: `/api/graphs/${id}` });
            expect((got.json() as { graph: Graph }).graph.stopped).toBe(true);
        } finally {
            await b.cleanup();
        }
    });

    it('an autonomous graph reads running unloaded; stop → stopped; resume → running (reloaded)', async () => {
        const b = boot(dir);
        try {
            const id = await createGraph(b.app, autonomousGraph());
            expect(await statusOf(b.app, id)).toBe('running');

            const stop = await inject(b.app, { method: 'POST', url: `/api/graphs/${id}/stop` });
            expect(stop.statusCode).toBe(200);
            expect(await statusOf(b.app, id)).toBe('stopped');

            const resume = await inject(b.app, { method: 'POST', url: `/api/graphs/${id}/resume` });
            expect(resume.statusCode).toBe(200);
            expect((resume.json() as { status: string }).status).toBe('running');
            expect(await statusOf(b.app, id)).toBe('running');
            const got = await inject(b.app, { method: 'GET', url: `/api/graphs/${id}` });
            expect((got.json() as { graph: Graph }).graph.stopped).toBe(false);
        } finally {
            await b.cleanup();
        }
    });

    it('resume of a non-autonomous graph leaves it idle', async () => {
        const b = boot(dir);
        try {
            const id = await createGraph(b.app, idleGraph());
            await inject(b.app, { method: 'POST', url: `/api/graphs/${id}/stop` });
            expect(await statusOf(b.app, id)).toBe('stopped');

            const resume = await inject(b.app, { method: 'POST', url: `/api/graphs/${id}/resume` });
            expect(resume.statusCode).toBe(200);
            expect((resume.json() as { status: string }).status).toBe('idle');
            expect(await statusOf(b.app, id)).toBe('idle');
        } finally {
            await b.cleanup();
        }
    });
});
