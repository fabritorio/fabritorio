import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import {
    buildDefaultSimpleHandlerGraph,
    DEFAULT_SIMPLE_HANDLER_ID,
} from '../../src/runtime/handlers/default-graph.js';
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

describe('HandlerNode.ref_id routes through the graph handler', () => {
    let graphsDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-handler-ref-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
    });

    it('a HandlerNode pointing at the seeded default-handler graph produces the assistant reply', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();

        await graphStore.seed(DEFAULT_SIMPLE_HANDLER_ID, buildDefaultSimpleHandlerGraph());

        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'agent-using-handler-ref',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h1',
                    type: 'handler',
                    ref_id: DEFAULT_SIMPLE_HANDLER_ID,
                    max_iterations: 4,
                    position: { x: 100, y: 0 },
                },
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
                    system_prompt: 'you are testy',
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

        const channelId = 'ch-href';
        const agentId = 'ag-href';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'demo',
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
            ],
            edges: [
                {
                    id: 'ch->ag',
                    source: { node_id: channelId },
                    target: { node_id: agentId },
                },
                {
                    id: 'ag->ch',
                    source: { node_id: agentId },
                    target: { node_id: channelId },
                },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const captured: CompleteRequest[] = [];
        const baseClient = scriptedClient([{ text: 'ack' }]);
        const wrapped: ModelClient = {
            async *complete(req) {
                captured.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
                yield* baseClient.complete(req);
            },
        };

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            modelClientFor: (_node: ModelNode) => wrapped,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            const channel = channels.get(channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((e) => {
                if (e.messages?.[0]?.role !== 'user') replies.push(e);
            });

            const post = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${channelId}/message`,
                payload: { content: 'hello' },
            });
            expect(post.statusCode).toBe(202);

            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages).toEqual([{ role: 'assistant', content: 'ack' }]);
            expect(replies[0]!.meta?.port).toBe('result');

            expect(captured).toHaveLength(1);
            expect(captured[0]!.messages[0]).toEqual({
                role: 'system',
                content: 'you are testy',
            });
            expect(captured[0]!.messages[1]).toMatchObject({
                role: 'user',
                content: 'hello',
            });
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/unload`,
            });
            await app.close();
        }
    });

    it('tolerates a missing ref_id at load; error surfaces on dispatch', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();

        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h1',
                    type: 'handler',
                    ref_id: '00000000-0000-4000-8000-00000000ffff',
                    position: { x: 100, y: 0 },
                },
                {
                    id: 'out',
                    type: 'output',
                    position: { x: 200, y: 0 },
                },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/gpt',
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
            nodes: [
                {
                    id: 'ch',
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [{ id: 'ch->ag', source: { node_id: 'ch' }, target: { node_id: 'ag' } }],
        };
        const savedL2 = await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            modelClientFor: () => scriptedClient([]),
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            const channel = channels.get('ch')!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/ch/message`,
                payload: { content: 'hello' },
            });
            await new Promise((r) => setTimeout(r, 30));

            const replay = await inject(app, {
                method: 'GET',
                url: `/api/channels/webchat/ch/replay`,
            });
            const body = replay.json() as {
                events: Array<{
                    type?: string;
                    port?: string;
                    messages?: Array<{ content?: string }>;
                }>;
            };
            const outEmit = body.events.find(
                (e) => e.type === 'output.emitted' && e.port === 'error',
            );
            expect(outEmit).toBeDefined();
            expect(outEmit!.messages?.[0]?.content).toMatch(/ref_id .* not found/);
            expect(replies).toHaveLength(0);
        } finally {
            await app.close();
        }
    });
});
