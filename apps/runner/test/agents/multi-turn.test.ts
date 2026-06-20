import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import { createMemoryRegistry } from '../../src/runtime/memory.js';
import type { CompleteRequest, ModelClient } from '../../src/runtime/model.js';
import { inject } from '../helpers/inject.js';

interface ScriptedReply {
    text?: string;
    tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

function scriptedClient(replies: ScriptedReply[]): ModelClient {
    let i = 0;
    return {
        async *complete(_req: CompleteRequest) {
            const reply = replies[i++];
            if (!reply) throw new Error('scripted client exhausted');
            if (reply.text) yield { delta: reply.text };
            yield {
                delta: '',
                finish_reason: reply.tool_calls ? 'tool_calls' : 'stop',
                ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}),
            };
        },
    };
}

interface DemoIds {
    l1Id: string;
    l2Id: string;
    channelId: string;
    agentId: string;
    memoryId: string;
}

async function setupMemoryDemo(
    graphsDir: string,
    client: ModelClient,
    capturedRequests: CompleteRequest[],
    memoryRegistry = createMemoryRegistry(),
    memoryConfig: {
        handling?: 'full_history' | 'last_n' | 'last_within_tokens';
        n?: number;
        token_budget?: number;
    } = {},
): Promise<{
    app: ReturnType<typeof buildServer>;
    channels: ReturnType<typeof createChannelRegistry>;
    memoryRegistry: ReturnType<typeof createMemoryRegistry>;
    ids: DemoIds;
}> {
    const graphStore = createGraphStore({ dir: graphsDir });
    const channels = createChannelRegistry();

    const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'memory-agent',
        nodes: [
            { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
            { id: 'h1', type: 'handler', position: { x: 100, y: 0 } },
            { id: 'out', type: 'output', ports: ['result', 'error'], position: { x: 200, y: 0 } },
            {
                id: 'm1',
                type: 'model',
                provider: 'fake',
                model_id: 'fake/gpt',
                system_prompt: 'You remember prior turns.',
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

    const channelId = 'ch-mem';
    const agentId = 'ag-mem';
    const memoryId = 'mem-1';
    const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l2',
        name: 'memory-demo',
        nodes: [
            {
                id: channelId,
                type: 'channel',
                channel_kind: 'webchat',
                position: { x: 0, y: 0 },
            },
            {
                id: agentId,
                type: 'native_agent',
                l1_graph_id: savedL1.id!,
                position: { x: 200, y: 0 },
            },
            {
                id: memoryId,
                type: 'memory',
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: memoryConfig.handling ?? 'full_history',
                tool_access: 'none',
                position: { x: 200, y: 120 },
                ...(memoryConfig.n !== undefined ? { n: memoryConfig.n } : {}),
                ...(memoryConfig.token_budget !== undefined
                    ? { token_budget: memoryConfig.token_budget }
                    : {}),
            },
        ],
        edges: [
            {
                id: 'ch->ag',
                source: { node_id: channelId, port_id: 'out' },
                target: { node_id: agentId, port_id: 'in' },
            },
            {
                id: 'ag->ch',
                source: { node_id: agentId, port_id: 'out' },
                target: { node_id: channelId, port_id: 'in' },
            },
            { id: 'mem->ag', source: { node_id: memoryId }, target: { node_id: agentId } },
        ],
    };
    const savedL2 = await graphStore.create(l2);

    const wrapped: ModelClient = {
        async *complete(req) {
            // Snapshot the messages at call time: the handler graph mutates the
            // live `messages` array after the call returns (it appends the
            // assistant reply), so a by-reference capture would otherwise show
            // post-call state.
            capturedRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
            yield* client.complete(req);
        },
    };
    const app = buildServer({
        logger: false,
        graphStore,
        channels,
        memoryRegistry,
        modelClientFor: (_node: ModelNode) => wrapped,
    });

    const load = await inject(app, {
        method: 'POST',
        url: `/api/graphs/${savedL2.id}/load`,
    });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }

    return {
        app,
        channels,
        memoryRegistry,
        ids: {
            l1Id: savedL1.id!,
            l2Id: savedL2.id!,
            channelId,
            agentId,
            memoryId,
        },
    };
}

describe('multi-turn memory: WebchatChannel → NativeAgent + Memory', () => {
    let graphsDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-mem-graphs-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
    });

    it('replays prior turns from Memory on the second message', async () => {
        const captured: CompleteRequest[] = [];
        const client = scriptedClient([
            { text: 'nice to meet you, alice' },
            { text: 'your name is alice' },
        ]);

        const { app, channels, memoryRegistry, ids } = await setupMemoryDemo(
            graphsDir,
            client,
            captured,
        );
        try {
            const channel = channels.get(ids.channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            const post1 = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'hi, my name is alice' },
            });
            expect(post1.statusCode).toBe(202);
            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages[0]).toEqual({
                role: 'assistant',
                content: 'nice to meet you, alice',
            });

            expect(captured).toHaveLength(1);
            const firstUserMessages = captured[0]!.messages.filter((m) => m.role === 'user');
            expect(firstUserMessages).toHaveLength(1);
            expect(firstUserMessages[0]!.content).toBe('hi, my name is alice');

            const handle = memoryRegistry.get(ids.memoryId)!;
            const stored = handle.read(`webchat:${ids.channelId}`);
            expect(stored).toEqual([
                { role: 'user', content: 'hi, my name is alice' },
                { role: 'assistant', content: 'nice to meet you, alice' },
            ]);

            const post2 = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'what is my name?' },
            });
            expect(post2.statusCode).toBe(202);
            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(2);
            expect(replies[1]!.messages[0]).toEqual({
                role: 'assistant',
                content: 'your name is alice',
            });

            expect(captured).toHaveLength(2);
            const secondNonSystem = captured[1]!.messages.filter((m) => m.role !== 'system');
            expect(secondNonSystem).toEqual([
                { role: 'user', content: 'hi, my name is alice' },
                { role: 'assistant', content: 'nice to meet you, alice' },
                { role: 'user', content: 'what is my name?' },
            ]);

            const storedAfter = handle.read(`webchat:${ids.channelId}`) as unknown[];
            expect(storedAfter).toHaveLength(4);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('isolates history per Dispatch source', async () => {
        const captured: CompleteRequest[] = [];
        const client = scriptedClient([{ text: 'hello alice' }, { text: 'hello bob' }]);
        const { app, memoryRegistry, ids } = await setupMemoryDemo(graphsDir, client, captured);
        try {
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'hi', source: 'user:alice' },
            });
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'hi', source: 'user:bob' },
            });
            await new Promise((r) => setTimeout(r, 30));

            const handle = memoryRegistry.get(ids.memoryId)!;
            const alice = handle.read('user:alice') as unknown[];
            const bob = handle.read('user:bob') as unknown[];
            expect(alice).toHaveLength(2);
            expect(bob).toHaveLength(2);
            expect(alice).not.toEqual(bob);

            expect((alice[0] as { content: string }).content).toBe('hi');
            expect((alice[1] as { content: string }).content).toBe('hello alice');
            expect((bob[1] as { content: string }).content).toBe('hello bob');
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('with handling=last_n n=2, only the last 2 user/assistant pairs reach the model', async () => {
        const captured: CompleteRequest[] = [];
        const client = scriptedClient([
            { text: 'reply1' },
            { text: 'reply2' },
            { text: 'reply3' },
            { text: 'reply4' },
        ]);
        const { app, ids } = await setupMemoryDemo(
            graphsDir,
            client,
            captured,
            createMemoryRegistry(),
            { handling: 'last_n', n: 2 },
        );
        try {
            const sendAndWait = async (content: string) => {
                const r = await inject(app, {
                    method: 'POST',
                    url: `/api/channels/webchat/${ids.channelId}/message`,
                    payload: { content },
                });
                expect(r.statusCode).toBe(202);
                await new Promise((res) => setTimeout(res, 30));
            };

            await sendAndWait('q1');
            await sendAndWait('q2');
            await sendAndWait('q3');
            await sendAndWait('q4');

            expect(captured).toHaveLength(4);
            const fourth = captured[3]!.messages.filter((m) => m.role !== 'system');
            expect(fourth).toEqual([
                { role: 'user', content: 'q2' },
                { role: 'assistant', content: 'reply2' },
                { role: 'user', content: 'q3' },
                { role: 'assistant', content: 'reply3' },
                { role: 'user', content: 'q4' },
            ]);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('with handling=last_within_tokens and a tight budget, only the surviving turns reach the model', async () => {
        const captured: CompleteRequest[] = [];
        const client = scriptedClient([
            { text: 'reply1' },
            { text: 'reply2' },
            { text: 'reply3' },
            { text: 'reply4' },
        ]);
        const { app, ids } = await setupMemoryDemo(
            graphsDir,
            client,
            captured,
            createMemoryRegistry(),
            { handling: 'last_within_tokens', token_budget: 30 },
        );
        try {
            const sendAndWait = async (content: string) => {
                const r = await inject(app, {
                    method: 'POST',
                    url: `/api/channels/webchat/${ids.channelId}/message`,
                    payload: { content },
                });
                expect(r.statusCode).toBe(202);
                await new Promise((res) => setTimeout(res, 30));
            };

            await sendAndWait('q1');
            await sendAndWait('q2');
            await sendAndWait('q3');
            await sendAndWait('q4');

            expect(captured).toHaveLength(4);
            const fourth = captured[3]!.messages.filter((m) => m.role !== 'system');
            expect(fourth).toEqual([
                { role: 'user', content: 'q2' },
                { role: 'assistant', content: 'reply2' },
                { role: 'user', content: 'q3' },
                { role: 'assistant', content: 'reply3' },
                { role: 'user', content: 'q4' },
            ]);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('preserves the Memory handle across graph unload', async () => {
        const captured: CompleteRequest[] = [];
        const client = scriptedClient([{ text: 'ok' }]);
        const memoryRegistry = createMemoryRegistry();
        const { app, ids } = await setupMemoryDemo(graphsDir, client, captured, memoryRegistry);
        try {
            const before = memoryRegistry.get(ids.memoryId);
            expect(before).toBeDefined();
            before!.write('probe', 'value');

            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });

            const after = memoryRegistry.get(ids.memoryId);
            expect(after).toBe(before);
            expect(after!.read('probe')).toBe('value');
        } finally {
            await app.close();
        }
    });
});
