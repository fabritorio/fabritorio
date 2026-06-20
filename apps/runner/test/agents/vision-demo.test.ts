import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import type { ChatMessage, CompleteRequest, ModelClient } from '../../src/runtime/model.js';
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

interface TestGraphIds {
    l1Id: string;
    l2Id: string;
    channelId: string;
    agentId: string;
}

async function setupVisionDemo(
    graphsDir: string,
    workspacePath: string,
    client: ModelClient,
    capturedRequests: CompleteRequest[],
): Promise<{
    app: ReturnType<typeof buildServer>;
    channels: ReturnType<typeof createChannelRegistry>;
    ids: TestGraphIds;
}> {
    const graphStore = createGraphStore({ dir: graphsDir });
    const channels = createChannelRegistry();

    const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'demo-agent',
        nodes: [
            { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
            {
                id: 'h1',
                type: 'handler',
                name: 'SimpleHandler',
                max_iterations: 4,
                position: { x: 100, y: 0 },
            },
            { id: 'out', type: 'output', ports: ['result', 'error'], position: { x: 200, y: 0 } },
            {
                id: 'm1',
                type: 'model',
                provider: 'fake',
                model_id: 'fake/gpt',
                system_prompt: 'You are the demo agent.',
                position: { x: 100, y: 80 },
            },
            {
                id: 't-read',
                type: 'tool',
                tool_name: 'read_file',
                position: { x: 100, y: 160 },
            },
            {
                id: 'ws',
                type: 'workspace',
                path: workspacePath,
                permissions: 'read',
                position: { x: 100, y: 240 },
            },
        ],
        edges: [
            {
                id: 'gw->h',
                source: { node_id: 'gw', port_id: 'out' },
                target: { node_id: 'h1', port_id: 'in' },
            },
            {
                id: 'h->out',
                source: { node_id: 'h1', port_id: 'out' },
                target: { node_id: 'out', port_id: 'in' },
            },
            { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
            { id: 't->h', source: { node_id: 't-read' }, target: { node_id: 'h1' } },
            { id: 'ws->h', source: { node_id: 'ws' }, target: { node_id: 'h1' } },
        ],
    };
    const savedL1 = await graphStore.create(l1);

    const channelId = 'ch-demo';
    const agentId = 'ag-demo';
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
                source: { node_id: channelId, port_id: 'out' },
                target: { node_id: agentId, port_id: 'in' },
            },
            {
                id: 'ag->ch',
                source: { node_id: agentId, port_id: 'out' },
                target: { node_id: channelId, port_id: 'in' },
            },
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
        ids: {
            l1Id: savedL1.id!,
            l2Id: savedL2.id!,
            channelId,
            agentId,
        },
    };
}

describe('vision demo: WebchatChannel → NativeAgent → WebchatChannel', () => {
    let graphsDir: string;
    let workspaceDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-demo-graphs-'));
        workspaceDir = mkdtempSync(join(tmpdir(), 'fabritorio-demo-ws-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it('routes a user message through the wired Tool back to the channel', async () => {
        mkdirSync(join(workspaceDir, 'notes'));
        writeFileSync(join(workspaceDir, 'notes', 'hello.txt'), 'the workspace says hi', 'utf8');

        const captured: CompleteRequest[] = [];
        const client = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-read',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'notes/hello.txt' }),
                    },
                ],
            },
            { text: 'I read it: the workspace says hi' },
        ]);

        const { app, channels, ids } = await setupVisionDemo(
            graphsDir,
            workspaceDir,
            client,
            captured,
        );
        try {
            const channel = channels.get(ids.channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            const post = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'please read notes/hello.txt' },
            });
            expect(post.statusCode).toBe(202);
            const root = (post.json() as { eventId: string }).eventId;

            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.source).toBe(`webchat:${ids.channelId}`);
            expect(replies[0]!.parentId).toBe(root);
            expect(replies[0]!.messages).toEqual([
                { role: 'assistant', content: 'I read it: the workspace says hi' },
            ]);
            expect(replies[0]!.meta?.port).toBe('result');

            const replay = await inject(app, {
                method: 'GET',
                url: `/api/channels/webchat/${ids.channelId}/replay`,
            });
            expect(replay.statusCode).toBe(200);
            const body = replay.json() as {
                roots: string[];
                events: Array<{ type?: string }>;
            };
            expect(body.roots).toEqual([root]);
            const types = body.events.map((e) => e.type ?? 'dispatch');
            expect(types).toContain('llm.request');
            expect(types).toContain('llm.response');
            expect(types).toContain('tool.called');
            expect(types).toContain('tool.result');
            expect(types).toContain('gateway.received');
            expect(types).toContain('output.emitted');

            expect(captured).toHaveLength(2);
            const second = captured[1]!.messages;
            expect(second.at(-1)).toMatchObject({
                role: 'tool',
                content: 'the workspace says hi',
                tool_call_id: 'call-read',
            });
            const sys = (captured[0]!.messages as ChatMessage[]).find((m) => m.role === 'system');
            expect(sys?.content).toContain('You are the demo agent.');
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('routes a workspace-escape attempt back as a tool error and recovers', async () => {
        const captured: CompleteRequest[] = [];
        const client = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-bad',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '../escape.txt' }),
                    },
                ],
            },
            { text: "couldn't read it: blocked" },
        ]);
        const { app, channels, ids } = await setupVisionDemo(
            graphsDir,
            workspaceDir,
            client,
            captured,
        );
        try {
            const channel = channels.get(ids.channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'read ../escape.txt' },
            });
            await new Promise((r) => setTimeout(r, 30));

            const second = captured[1]!.messages;
            const last = second.at(-1) as ChatMessage;
            expect(last.role).toBe('tool');
            expect(last.content).toMatch(/escapes workspace/);

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages).toEqual([
                { role: 'assistant', content: "couldn't read it: blocked" },
            ]);
            expect(replies[0]!.meta?.port).toBe('result');
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('tolerates an unwired native_agent whose L1 is missing', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'broken',
            nodes: [
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: '00000000-0000-4000-8000-000000000000',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        };
        const saved = await graphStore.create(l2);
        const app = buildServer({ logger: false, graphStore });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${saved.id}/load`,
            });
            expect(load.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it('accepts the canvas convention `Handler → Model` edge direction', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'h1', type: 'handler', position: { x: 0, y: 0 } },
                { id: 'out', type: 'output', position: { x: 0, y: 0 } },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'openai',
                    model_id: 'gpt-4o-mini',
                    auth_env: 'OPENAI_API_KEY',
                    system_prompt: 'demo',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [
                { id: 'e1', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'e2', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'e3', source: { node_id: 'h1' }, target: { node_id: 'm1' } },
            ],
        };
        const savedL1 = await graphStore.create(l1);
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            nodes: [
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        };
        const savedL2 = await graphStore.create(l2);
        const app = buildServer({
            logger: false,
            graphStore,
            modelClientFor: () => scriptedClient([{ text: 'ok' }]),
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it('tolerates a broken L1 at load; surfaces the build error on dispatch', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();
        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'h1', type: 'handler', position: { x: 0, y: 0 } },
                { id: 'out', type: 'output', position: { x: 0, y: 0 } },
            ],
            edges: [
                { id: 'e1', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'e2', source: { node_id: 'h1' }, target: { node_id: 'out' } },
            ],
        };
        const savedL1 = await graphStore.create(l1);
        const channelId = 'ch-broken';
        const agentId = 'ag-broken';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
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
                    source: { node_id: channelId, port_id: 'out' },
                    target: { node_id: agentId, port_id: 'in' },
                },
                {
                    id: 'ag->ch',
                    source: { node_id: agentId, port_id: 'out' },
                    target: { node_id: channelId, port_id: 'in' },
                },
            ],
        };
        const savedL2 = await graphStore.create(l2);
        const app = buildServer({ logger: false, graphStore, channels });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            const channel = channels.get(channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            const post = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${channelId}/message`,
                payload: { content: 'hello' },
            });
            expect(post.statusCode).toBe(202);
            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.meta?.port).toBe('error');
            expect(replies[0]!.messages[0]!.content).toMatch(/Handler has no Model wired/);
        } finally {
            await app.close();
        }
    });
});
