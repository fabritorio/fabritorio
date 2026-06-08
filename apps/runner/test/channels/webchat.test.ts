import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { createWebchatBinding } from '../../src/runtime/bindings/webchat.js';
import { inject } from '../helpers/inject.js';

const CHANNEL_ID = 'ch-webchat';
const AGENT_ID = 'ag-stub';

function l2WithChannel(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'demo',
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
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 100, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-out',
                source: { node_id: CHANNEL_ID, port_id: 'out' },
                target: { node_id: AGENT_ID, port_id: 'in' },
            },
            {
                id: 'e-in',
                source: { node_id: AGENT_ID, port_id: 'out' },
                target: { node_id: CHANNEL_ID, port_id: 'in' },
            },
        ],
    };
}

interface BootResult {
    app: ReturnType<typeof buildServer>;
    agentInbox: DispatchEvent[];
    bus: ReturnType<typeof createEventBus>;
    channels: ReturnType<typeof createChannelRegistry>;
    graphId: string;
    cleanup(): Promise<void>;
}

async function bootWithLoadedGraph(dir: string): Promise<BootResult> {
    const graphStore = createGraphStore({ dir });
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const nodes = createNodeRegistry();
    nodes.register('channel', createWebchatBinding(channels));

    const agentInbox: DispatchEvent[] = [];
    nodes.register('native_agent', {
        receiver: () => (event) => {
            agentInbox.push(event);
        },
    });

    const runtimes = createGraphRuntimeRegistry({ bus, nodes });
    const app = buildServer({
        logger: false,
        graphStore,
        bus,
        runtimes,
        nodes,
        channels,
    });

    const create = await inject(app, {
        method: 'POST',
        url: '/api/graphs',
        payload: l2WithChannel(),
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
        agentInbox,
        bus,
        channels,
        graphId,
        async cleanup() {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${graphId}/unload`,
            });
            await app.close();
        },
    };
}

describe('WebchatChannel routes', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-webchat-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('POST /message fabricates a Dispatch and publishes to the wired agent', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/channels/webchat/${CHANNEL_ID}/message`,
                payload: { content: 'hello' },
            });
            expect(res.statusCode).toBe(202);
            const body = res.json() as { eventId: string; source: string };
            expect(body.source).toBe(`webchat:${CHANNEL_ID}`);
            expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/);

            expect(boot.agentInbox).toHaveLength(1);
            expect(boot.agentInbox[0]!.eventId).toBe(body.eventId);
            expect(boot.agentInbox[0]!.messages).toEqual([{ role: 'user', content: 'hello' }]);
        } finally {
            await boot.cleanup();
        }
    });

    it('echoes the user-root Dispatch to channel SSE subscribers while still blocking on fan-out (Phase 4.1)', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const channel = boot.channels.get(CHANNEL_ID)!;
            const echoed: DispatchEvent[] = [];
            const off = channel.subscribe((e) => echoed.push(e));

            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/channels/webchat/${CHANNEL_ID}/message`,
                payload: { content: 'hello' },
            });
            expect(res.statusCode).toBe(202);
            const body = res.json() as { eventId: string };

            expect(echoed).toHaveLength(1);
            expect(echoed[0]!.eventId).toBe(body.eventId);
            expect(echoed[0]!.parentId ?? null).toBeNull();
            expect(echoed[0]!.messages).toEqual([{ role: 'user', content: 'hello' }]);

            expect(boot.agentInbox).toHaveLength(1);
            expect(boot.agentInbox[0]!.eventId).toBe(body.eventId);
            off();
        } finally {
            await boot.cleanup();
        }
    });

    it('rejects missing/empty content with 400 and unknown channel with 404', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const empty = await inject(boot.app, {
                method: 'POST',
                url: `/api/channels/webchat/${CHANNEL_ID}/message`,
                payload: { content: '' },
            });
            expect(empty.statusCode).toBe(400);

            const ghost = await inject(boot.app, {
                method: 'POST',
                url: `/api/channels/webchat/no-such-channel/message`,
                payload: { content: 'hi' },
            });
            expect(ghost.statusCode).toBe(404);
        } finally {
            await boot.cleanup();
        }
    });

    it('/replay returns recorded roots + observability events for the source', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            await inject(boot.app, {
                method: 'POST',
                url: `/api/channels/webchat/${CHANNEL_ID}/message`,
                payload: { content: 'first' },
            });
            await inject(boot.app, {
                method: 'POST',
                url: `/api/channels/webchat/${CHANNEL_ID}/message`,
                payload: { content: 'second', source: 'webchat:user-A' },
            });

            const defaultReplay = await inject(boot.app, {
                method: 'GET',
                url: `/api/channels/webchat/${CHANNEL_ID}/replay`,
            });
            expect(defaultReplay.statusCode).toBe(200);
            const defaultBody = defaultReplay.json() as {
                roots: string[];
                events: DispatchEvent[];
            };
            expect(defaultBody.roots).toHaveLength(1);
            expect(defaultBody.events).toHaveLength(1);
            expect(defaultBody.events[0]!.messages).toEqual([{ role: 'user', content: 'first' }]);

            const userA = await inject(boot.app, {
                method: 'GET',
                url: `/api/channels/webchat/${CHANNEL_ID}/replay?source=webchat:user-A`,
            });
            const userBody = userA.json() as { roots: string[] };
            expect(userBody.roots).toHaveLength(1);
        } finally {
            await boot.cleanup();
        }
    });

    it('SSE /stream delivers inbound events the channel receiver collects', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const reply: DispatchEvent = {
                eventId: 'reply-1',
                source: `agent:${AGENT_ID}`,
                timestamp: 0,
                messages: [{ role: 'assistant', content: 'hi back' }],
            };

            const channel = boot.channels.get(CHANNEL_ID)!;
            const got: DispatchEvent[] = [];
            const off = channel.subscribe((e) => got.push(e));

            await boot.bus.publish('e-in', reply);
            expect(got).toEqual([reply]);
            off();
        } finally {
            await boot.cleanup();
        }
    });

    it('unloading a graph drops the channel from the registry', async () => {
        const boot = await bootWithLoadedGraph(dir);
        expect(boot.channels.get(CHANNEL_ID)).toBeDefined();
        await inject(boot.app, {
            method: 'POST',
            url: `/api/graphs/${boot.graphId}/unload`,
        });
        expect(boot.channels.get(CHANNEL_ID)).toBeUndefined();
        await boot.app.close();
    });
});
