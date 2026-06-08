import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, GatewayReceivedEvent, Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { inject } from '../helpers/inject.js';

const TRIGGER_ID = 'trg';
const AGENT_ID = 'ag';
const CHANNEL_ID = 'ch';

function graphWithTrigger(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'trigger-runs',
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
            {
                id: CHANNEL_ID,
                type: 'channel',
                channel_kind: 'webchat',
                position: { x: 400, y: 0 },
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

interface BootResult {
    app: ReturnType<typeof buildServer>;
    bus: ReturnType<typeof createEventBus>;
    graphId: string;
    cleanup(): Promise<void>;
}

async function bootWithLoadedGraph(dir: string): Promise<BootResult> {
    const graphStore = createGraphStore({ dir });
    const bus = createEventBus();
    const nodes = createNodeRegistry();
    nodes.register('trigger', { activate: () => null });
    nodes.register('native_agent', { receiver: () => () => undefined });
    nodes.register('channel', { receiver: () => () => undefined });

    const runtimes = createGraphRuntimeRegistry({ bus, nodes });
    const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });

    const create = await inject(app, {
        method: 'POST',
        url: '/api/graphs',
        payload: graphWithTrigger(),
    });
    const graphId = (create.json() as { graph: Graph }).graph.id!;
    const load = await inject(app, {
        method: 'POST',
        url: `/api/graphs/${graphId}/load`,
    });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }

    return {
        app,
        bus,
        graphId,
        async cleanup() {
            await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/unload` });
            await app.close();
        },
    };
}

function fakeDispatch(eventId: string, source: string, timestamp: number): DispatchEvent {
    return {
        eventId,
        source,
        timestamp,
        messages: [{ role: 'user', content: 'go' }],
    };
}

function fakeGatewayReceived(eventId: string, agentNodeId: string): GatewayReceivedEvent {
    return {
        ts: new Date().toISOString(),
        eventId,
        parentId: eventId,
        node_id: agentNodeId,
        type: 'gateway.received',
        source: `trigger:${TRIGGER_ID}`,
        messages: [{ role: 'user', content: 'go' }],
    };
}

describe('trigger routes', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-triggers-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('GET /runs returns rootEventIds newest-first with timestamps + downstream', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const source = `trigger:${TRIGGER_ID}`;
            boot.bus.emitDispatch(fakeDispatch('e1', source, 1000));
            boot.bus.emitObservability(fakeGatewayReceived('e1', AGENT_ID));
            boot.bus.emitDispatch(fakeDispatch('e2', source, 2000));
            boot.bus.emitObservability(fakeGatewayReceived('e2', AGENT_ID));
            boot.bus.emitDispatch(fakeDispatch('e3', source, 3000));
            boot.bus.emitObservability(fakeGatewayReceived('e3', AGENT_ID));

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/runs`,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
                source: string;
                runs: Array<{
                    eventId: string;
                    timestamp: number;
                    status: string;
                    downstream: string[];
                }>;
            };
            expect(body.source).toBe(source);
            expect(body.runs.map((r) => r.eventId)).toEqual(['e3', 'e2', 'e1']);
            expect(body.runs.map((r) => r.timestamp)).toEqual([3000, 2000, 1000]);
            expect(body.runs[0]!.status).toBe('ok');
            expect(body.runs[0]!.downstream).toEqual([AGENT_ID]);
        } finally {
            await boot.cleanup();
        }
    });

    it('GET /runs paging: limit caps results, before excludes runs at/after that timestamp', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const source = `trigger:${TRIGGER_ID}`;
            for (let i = 1; i <= 5; i++) {
                boot.bus.emitDispatch(fakeDispatch(`e${i}`, source, i * 1000));
            }

            const limited = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/runs?limit=2`,
            });
            expect(limited.statusCode).toBe(200);
            const limitedBody = limited.json() as { runs: Array<{ eventId: string }> };
            expect(limitedBody.runs.map((r) => r.eventId)).toEqual(['e5', 'e4']);

            const beforeIso = new Date(3000).toISOString();
            const beforeRes = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/runs?before=${encodeURIComponent(beforeIso)}`,
            });
            const beforeBody = beforeRes.json() as { runs: Array<{ eventId: string }> };
            expect(beforeBody.runs.map((r) => r.eventId)).toEqual(['e2', 'e1']);
        } finally {
            await boot.cleanup();
        }
    });

    it('GET /runs 404s on unknown graph, unknown node, and non-trigger node', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const ghostGraph = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/00000000-0000-4000-8000-deadbeefdead/${TRIGGER_ID}/runs`,
            });
            expect(ghostGraph.statusCode).toBe(404);
            expect(ghostGraph.json()).toEqual({ error: 'graph not loaded' });

            const ghostNode = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/no-such-node/runs`,
            });
            expect(ghostNode.statusCode).toBe(404);
            expect(ghostNode.json()).toEqual({ error: 'trigger node not found' });

            const wrongKind = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${CHANNEL_ID}/runs`,
            });
            expect(wrongKind.statusCode).toBe(404);
            expect(wrongKind.json()).toEqual({ error: 'trigger node not found' });
        } finally {
            await boot.cleanup();
        }
    });

    it('GET /runs/:eventId returns the events for that tree', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const source = `trigger:${TRIGGER_ID}`;
            boot.bus.emitDispatch(fakeDispatch('e1', source, 1000));
            boot.bus.emitObservability(fakeGatewayReceived('e1', AGENT_ID));

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/runs/e1`,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { events: Array<{ eventId: string }> };
            expect(body.events).toHaveLength(2);
            expect(body.events.every((e) => e.eventId === 'e1')).toBe(true);
        } finally {
            await boot.cleanup();
        }
    });

    it('GET /runs/:eventId 404s when the eventId is not a root of this trigger', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(fakeDispatch('other-1', 'webchat:somewhere-else', 1000));

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/runs/other-1`,
            });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ error: 'event not found for this trigger' });

            const missing = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/runs/never-emitted`,
            });
            expect(missing.statusCode).toBe(404);
        } finally {
            await boot.cleanup();
        }
    });
});
