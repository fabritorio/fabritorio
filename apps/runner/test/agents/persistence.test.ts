import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createEventLog } from '../../src/runtime/event-log.js';
import { createMemoryRegistry } from '../../src/runtime/memory.js';
import type { CompleteRequest, ModelClient } from '../../src/runtime/model.js';
import { inject } from '../helpers/inject.js';

interface ScriptedReply {
    text?: string;
}

function scriptedClient(replies: ScriptedReply[]): ModelClient {
    let i = 0;
    return {
        async *complete(_req: CompleteRequest) {
            const reply = replies[i++];
            if (!reply) throw new Error('scripted client exhausted');
            if (reply.text) yield { delta: reply.text };
            yield { delta: '', finish_reason: 'stop' };
        },
    };
}

const CHANNEL_ID = 'ch-mem';
const AGENT_ID = 'ag-mem';
const MEMORY_ID = 'mem-1';

async function buildL2(graphsDir: string): Promise<{
    l1Id: string;
    l2Id: string;
}> {
    const graphStore = createGraphStore({ dir: graphsDir });
    const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'memory-agent',
        nodes: [
            { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
            { id: 'h1', type: 'handler', position: { x: 100, y: 0 } },
            {
                id: 'out',
                type: 'output',
                ports: ['result', 'error'],
                position: { x: 200, y: 0 },
            },
            {
                id: 'm1',
                type: 'model',
                provider: 'fake',
                model_id: 'fake/gpt',
                system_prompt: 'remember turns',
                position: { x: 100, y: 80 },
            },
        ],
        edges: [
            { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
            { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
            { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
        ],
    };
    const savedL1 = await graphStore.create(l1);

    const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l2',
        name: 'persisted-demo',
        nodes: [
            {
                id: CHANNEL_ID,
                type: 'channel',
                channel_kind: 'webchat',
                position: { x: 0, y: 0 },
            },
            {
                id: AGENT_ID,
                type: 'native_agent',
                l1_graph_id: savedL1.id!,
                position: { x: 200, y: 0 },
            },
            {
                id: MEMORY_ID,
                type: 'memory',
                storage: 'local_storage',
                storage_kind: 'kv',
                handling: 'full_history',
                tool_access: 'none',
                position: { x: 200, y: 120 },
            },
        ],
        edges: [
            {
                id: 'ch->ag',
                source: { node_id: CHANNEL_ID, port_id: 'out' },
                target: { node_id: AGENT_ID, port_id: 'in' },
            },
            {
                id: 'ag->ch',
                source: { node_id: AGENT_ID, port_id: 'out' },
                target: { node_id: CHANNEL_ID, port_id: 'in' },
            },
            {
                id: 'mem->ag',
                source: { node_id: MEMORY_ID },
                target: { node_id: AGENT_ID },
            },
        ],
    };
    const savedL2 = await graphStore.create(l2);
    return { l1Id: savedL1.id!, l2Id: savedL2.id! };
}

interface RunnerHandle {
    app: ReturnType<typeof buildServer>;
    capturedRequests: CompleteRequest[];
    bus: ReturnType<typeof createEventBus>;
    eventLog: ReturnType<typeof createEventLog>;
}

async function bootRunner(opts: {
    graphsDir: string;
    eventsDir: string;
    memoryDir: string;
    l2Id: string;
    client: ModelClient;
}): Promise<RunnerHandle> {
    const graphStore = createGraphStore({ dir: opts.graphsDir });
    const eventLog = createEventLog({ dir: opts.eventsDir });
    const bus = createEventBus();
    const prior = await eventLog.readAll();
    bus.hydrate(prior);

    const capturedRequests: CompleteRequest[] = [];
    const wrapped: ModelClient = {
        async *complete(req) {
            // Snapshot the messages at call time: the handler graph mutates the
            // live `messages` array after the call returns (it appends the
            // assistant reply), so a by-reference capture would otherwise show
            // post-call state.
            capturedRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
            yield* opts.client.complete(req);
        },
    };

    const app = buildServer({
        logger: false,
        graphStore,
        bus,
        eventLog,
        memoryRegistry: createMemoryRegistry({ localStorageDir: opts.memoryDir }),
        modelClientFor: (_n: ModelNode) => wrapped,
    });

    const load = await inject(app, {
        method: 'POST',
        url: `/api/graphs/${opts.l2Id}/load`,
    });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }
    return { app, capturedRequests, bus, eventLog };
}

describe('persistence: event log + local_storage Memory survive restart', () => {
    let graphsDir: string;
    let eventsDir: string;
    let memoryDir: string;
    let l2Id: string;

    beforeEach(async () => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-p7-graphs-'));
        eventsDir = mkdtempSync(join(tmpdir(), 'fabritorio-p7-events-'));
        memoryDir = mkdtempSync(join(tmpdir(), 'fabritorio-p7-mem-'));
        ({ l2Id } = await buildL2(graphsDir));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(eventsDir, { recursive: true, force: true });
        rmSync(memoryDir, { recursive: true, force: true });
    });

    it('a restart sees the prior turn in Memory and the prior dispatch in the event log', async () => {
        const first = await bootRunner({
            graphsDir,
            eventsDir,
            memoryDir,
            l2Id,
            client: scriptedClient([{ text: 'nice to meet you, alice' }]),
        });
        const post1 = await inject(first.app, {
            method: 'POST',
            url: `/api/channels/webchat/${CHANNEL_ID}/message`,
            payload: { content: 'hi, my name is alice' },
        });
        expect(post1.statusCode).toBe(202);
        const firstEventId = (post1.json() as { eventId: string }).eventId;
        await new Promise((r) => setTimeout(r, 30));
        await first.eventLog.flush();
        await inject(first.app, { method: 'POST', url: `/api/graphs/${l2Id}/unload` });
        await first.app.close();

        const second = await bootRunner({
            graphsDir,
            eventsDir,
            memoryDir,
            l2Id,
            client: scriptedClient([{ text: 'your name is alice' }]),
        });
        try {
            expect(second.bus.rootEventIdsBySource(`webchat:${CHANNEL_ID}`)).toContain(
                firstEventId,
            );
            expect(second.bus.eventsByDispatch(firstEventId).length).toBeGreaterThan(0);

            const replay = await inject(second.app, {
                method: 'GET',
                url: `/api/channels/webchat/${CHANNEL_ID}/replay`,
            });
            expect(replay.statusCode).toBe(200);
            const replayBody = replay.json() as {
                roots: string[];
                events: Array<{ eventId: string; messages?: { content: string }[] }>;
            };
            expect(replayBody.roots).toContain(firstEventId);
            const firstUser = replayBody.events.find(
                (e) => e.eventId === firstEventId && e.messages?.[0]?.content,
            );
            expect(firstUser?.messages?.[0]?.content).toBe('hi, my name is alice');

            const post2 = await inject(second.app, {
                method: 'POST',
                url: `/api/channels/webchat/${CHANNEL_ID}/message`,
                payload: { content: 'what is my name?' },
            });
            expect(post2.statusCode).toBe(202);
            await new Promise((r) => setTimeout(r, 30));

            expect(second.capturedRequests).toHaveLength(1);
            const nonSystem = second.capturedRequests[0]!.messages.filter(
                (m) => m.role !== 'system',
            );
            expect(nonSystem).toEqual([
                { role: 'user', content: 'hi, my name is alice' },
                { role: 'assistant', content: 'nice to meet you, alice' },
                { role: 'user', content: 'what is my name?' },
            ]);
        } finally {
            await second.eventLog.flush();
            await inject(second.app, {
                method: 'POST',
                url: `/api/graphs/${l2Id}/unload`,
            });
            await second.app.close();
        }
    });
});
