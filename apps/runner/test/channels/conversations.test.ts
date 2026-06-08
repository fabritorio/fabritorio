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

function emptyL2(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return { kind: 'l2', name: 'chat-demo', nodes: [], edges: [] };
}

interface BootResult {
    app: ReturnType<typeof buildServer>;
    agentInbox: DispatchEvent[];
    bus: ReturnType<typeof createEventBus>;
    graphId: string;
    agentId: string;
    channelNodeId: string;
    cleanup(): Promise<void>;
}

async function boot(dir: string): Promise<BootResult> {
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
    const conversationsDir = join(dir, 'conversations');
    const app = buildServer({
        logger: false,
        graphStore,
        bus,
        runtimes,
        nodes,
        channels,
        conversationsDir,
    });

    await app.bootstrapComplete;

    const create = await inject(app, { method: 'POST', url: '/api/graphs', payload: emptyL2() });
    const graphId = (create.json() as { graph: Graph }).graph.id!;

    const ops = await inject(app, {
        method: 'POST',
        url: `/api/graphs/${graphId}/ops`,
        payload: {
            ops: [{ op: 'add_node', kind: 'native_agent', position: { x: 0, y: 0 } }],
        },
    });
    if (ops.statusCode !== 200) {
        throw new Error(`ops failed: ${ops.statusCode} ${ops.body}`);
    }
    const graph = (ops.json() as { graph: Graph }).graph;
    const agentNode = graph.nodes.find((n) => n.type === 'native_agent');
    if (!agentNode) throw new Error('expected agent node');
    const agentId = agentNode.id;
    const sidecarChannel = graph.nodes.find(
        (n) => n.type === 'channel' && n.owner_node_id === agentId,
    );
    if (!sidecarChannel) {
        throw new Error('expected sidecar channel on created graph');
    }

    const load = await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/load` });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }

    return {
        app,
        agentInbox,
        bus,
        graphId,
        agentId,
        channelNodeId: sidecarChannel.id,
        async cleanup() {
            await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/unload` });
            await app.close();
        },
    };
}

describe('B6 conversation minting + listing', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-conv-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('mints chat:<agentId>:<convId> when posting with no convId', async () => {
        const b = await boot(dir);
        try {
            const res = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'hello' },
            });
            expect(res.statusCode).toBe(202);
            const body = res.json() as { source: string; convId?: string };
            expect(body.convId).toBeTruthy();
            expect(body.source).toBe(`chat:${b.agentId}:${body.convId}`);
        } finally {
            await b.cleanup();
        }
    });

    it('reuses an existing convId when one is supplied', async () => {
        const b = await boot(dir);
        try {
            const first = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'one' },
            });
            const convId = (first.json() as { convId: string }).convId;

            const second = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'two', convId },
            });
            const body = second.json() as { source: string; convId: string };
            expect(body.convId).toBe(convId);
            expect(body.source).toBe(`chat:${b.agentId}:${convId}`);
        } finally {
            await b.cleanup();
        }
    });

    it('publishes to an explicit source verbatim and recovers its convId', async () => {
        const b = await boot(dir);
        try {
            const source = `chat:${b.agentId}:fixed123`;
            const res = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'pinned', source },
            });
            const body = res.json() as { source: string; convId?: string };
            expect(body.source).toBe(source);
            expect(body.convId).toBe('fixed123');
        } finally {
            await b.cleanup();
        }
    });

    it('lists one entry per distinct convId, scoped to this agent', async () => {
        const b = await boot(dir);
        try {
            const a = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'a1' },
            });
            const convA = (a.json() as { convId: string }).convId;
            await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'a2', convId: convA },
            });
            const c = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'b1' },
            });
            const convB = (c.json() as { convId: string }).convId;

            b.bus.emitDispatch({
                eventId: 'ask-root-1',
                source: `ask:${b.agentId}->other`,
                timestamp: Date.now(),
                messages: [{ role: 'user', content: 'delegated' }],
            });
            b.bus.emitDispatch({
                eventId: 'trigger-root-1',
                source: `trigger:${b.agentId}`,
                timestamp: Date.now(),
                messages: [{ role: 'user', content: 'fired' }],
            });

            const list = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            expect(list.statusCode).toBe(200);
            const body = list.json() as {
                conversations: { convId: string; source: string; rootEventId: string }[];
            };
            const convIds = body.conversations.map((c2) => c2.convId).sort();
            expect(convIds).toEqual([convA, convB].sort());
            for (const conv of body.conversations) {
                expect(conv.source.startsWith(`chat:${b.agentId}:`)).toBe(true);
            }
        } finally {
            await b.cleanup();
        }
    });

    it('reports per-conversation bytes, accumulating across turns of the same convId', async () => {
        const b = await boot(dir);
        try {
            const single = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'just one turn' },
            });
            const convSingle = (single.json() as { convId: string }).convId;

            const firstTurn = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'turn one' },
            });
            const convMulti = (firstTurn.json() as { convId: string }).convId;
            await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'turn two', convId: convMulti },
            });

            const list = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            expect(list.statusCode).toBe(200);
            const body = list.json() as {
                conversations: {
                    convId: string;
                    source: string;
                    rootEventId: string;
                    bytes: number;
                }[];
            };

            const single1 = body.conversations.find((c) => c.convId === convSingle);
            const multi = body.conversations.find((c) => c.convId === convMulti);
            expect(single1).toBeDefined();
            expect(multi).toBeDefined();

            expect(single1!.bytes).toBeGreaterThan(0);
            expect(multi!.bytes).toBeGreaterThan(0);

            expect(multi!.bytes).toBeGreaterThan(single1!.bytes);
        } finally {
            await b.cleanup();
        }
    });

    it('renames a conversation via PUT label → it appears on the list; empty clears it', async () => {
        const b = await boot(dir);
        try {
            const post = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'name me' },
            });
            const convId = (post.json() as { convId: string }).convId;

            const before = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            const beforeConv = (
                before.json() as { conversations: { convId: string; label?: string }[] }
            ).conversations.find((c) => c.convId === convId);
            expect(beforeConv).toBeDefined();
            expect(beforeConv!.label).toBeUndefined();

            const put = await inject(b.app, {
                method: 'PUT',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations/${convId}/label`,
                payload: { label: '  Project kickoff  ' },
            });
            expect(put.statusCode).toBe(200);
            expect((put.json() as { label: string }).label).toBe('Project kickoff');

            const labeled = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            const labeledConv = (
                labeled.json() as { conversations: { convId: string; label?: string }[] }
            ).conversations.find((c) => c.convId === convId);
            expect(labeledConv!.label).toBe('Project kickoff');

            const clear = await inject(b.app, {
                method: 'PUT',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations/${convId}/label`,
                payload: { label: '   ' },
            });
            expect(clear.statusCode).toBe(200);
            expect((clear.json() as { label: string }).label).toBe('');

            const cleared = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            const clearedConv = (
                cleared.json() as { conversations: { convId: string; label?: string }[] }
            ).conversations.find((c) => c.convId === convId);
            expect(clearedConv!.label).toBeUndefined();
        } finally {
            await b.cleanup();
        }
    });

    it('rejects a non-string label with 400', async () => {
        const b = await boot(dir);
        try {
            const post = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'x' },
            });
            const convId = (post.json() as { convId: string }).convId;
            const bad = await inject(b.app, {
                method: 'PUT',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations/${convId}/label`,
                payload: { label: 42 },
            });
            expect(bad.statusCode).toBe(400);
        } finally {
            await b.cleanup();
        }
    });

    it('deleting a conversation removes its label too', async () => {
        const b = await boot(dir);
        try {
            const post = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'labeled then doomed' },
            });
            const convId = (post.json() as { convId: string }).convId;

            await inject(b.app, {
                method: 'PUT',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations/${convId}/label`,
                payload: { label: 'soon gone' },
            });

            const del = await inject(b.app, {
                method: 'DELETE',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations/${convId}`,
            });
            expect(del.statusCode).toBe(204);

            await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'reborn', convId },
            });
            const after = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            const conv = (
                after.json() as { conversations: { convId: string; label?: string }[] }
            ).conversations.find((c) => c.convId === convId);
            expect(conv).toBeDefined();
            expect(conv!.label).toBeUndefined();
        } finally {
            await b.cleanup();
        }
    });

    it('deletes a conversation: it disappears from the list (bus-forget path)', async () => {
        const b = await boot(dir);
        try {
            const post = await inject(b.app, {
                method: 'POST',
                url: `/api/channels/webchat/${b.channelNodeId}/message`,
                payload: { content: 'doomed conversation' },
            });
            const convId = (post.json() as { convId: string }).convId;

            const before = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            const beforeIds = (
                before.json() as { conversations: { convId: string }[] }
            ).conversations.map((c) => c.convId);
            expect(beforeIds).toContain(convId);

            const del = await inject(b.app, {
                method: 'DELETE',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations/${convId}`,
            });
            expect(del.statusCode).toBe(204);

            const after = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations`,
            });
            const afterIds = (
                after.json() as { conversations: { convId: string }[] }
            ).conversations.map((c) => c.convId);
            expect(afterIds).not.toContain(convId);
        } finally {
            await b.cleanup();
        }
    });

    it('delete is idempotent: deleting an unknown convId still returns 204', async () => {
        const b = await boot(dir);
        try {
            const del = await inject(b.app, {
                method: 'DELETE',
                url: `/api/agents/${b.graphId}/${b.agentId}/conversations/no-such-conv`,
            });
            expect(del.statusCode).toBe(204);
        } finally {
            await b.cleanup();
        }
    });

    it('returns 404 for an unloaded graph and 404 for a missing agent', async () => {
        const b = await boot(dir);
        try {
            const ghost = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/no-such-graph/${b.agentId}/conversations`,
            });
            expect(ghost.statusCode).toBe(404);

            const missingAgent = await inject(b.app, {
                method: 'GET',
                url: `/api/agents/${b.graphId}/no-such-agent/conversations`,
            });
            expect(missingAgent.statusCode).toBe(404);
        } finally {
            await b.cleanup();
        }
    });
});
