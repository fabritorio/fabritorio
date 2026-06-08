import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
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

describe('agent resolves wired ToolPack via referenced L0 graph', () => {
    let graphsDir: string;
    let workspaceDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-pack-graphs-'));
        workspaceDir = mkdtempSync(join(tmpdir(), 'fabritorio-pack-ws-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("expands a wired tool_pack's ref_id into the agent's tool list", async () => {
        mkdirSync(join(workspaceDir, 'notes'));
        writeFileSync(join(workspaceDir, 'notes', 'hello.txt'), 'from inside the pack', 'utf8');

        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();

        const l0: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'toolpack',
            name: 'fs-pack',
            nodes: [
                {
                    id: 'inner-read',
                    type: 'tool',
                    tool_name: 'read_file',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        };
        const savedL0 = await graphStore.create(l0);

        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'agent-with-pack',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h1',
                    type: 'handler',
                    name: 'SimpleHandler',
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
                    system_prompt: 'ok',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'pack-1',
                    type: 'tool_pack',
                    pack_name: 'fs',
                    ref_id: savedL0.id!,
                    position: { x: 100, y: 160 },
                },
                {
                    id: 'ws',
                    type: 'workspace',
                    path: workspaceDir,
                    permissions: 'read',
                    position: { x: 100, y: 240 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                {
                    id: 'pack->h',
                    source: { node_id: 'pack-1' },
                    target: { node_id: 'h1' },
                },
                { id: 'ws->h', source: { node_id: 'ws' }, target: { node_id: 'h1' } },
            ],
        };
        const savedL1 = await graphStore.create(l1);

        const channelId = 'ch-pack';
        const agentId = 'ag-pack';
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
        const baseClient = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-read',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'notes/hello.txt' }),
                    },
                ],
            },
            { text: 'got it: from inside the pack' },
        ]);
        const wrapped: ModelClient = {
            async *complete(req) {
                captured.push(req);
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
                payload: { content: 'read notes/hello.txt' },
            });
            expect(post.statusCode).toBe(202);

            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages).toEqual([
                { role: 'assistant', content: 'got it: from inside the pack' },
            ]);
            expect(replies[0]!.meta?.port).toBe('result');

            const firstReq = captured[0]!;
            const advertisedNames = firstReq.tools?.map((t) => t.name) ?? [];
            expect(advertisedNames).toContain('read_file');
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/unload`,
            });
            await app.close();
        }
    });

    it('rejects load when a wired tool_pack ref_id points at a missing graph', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();

        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'broken-ref',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h1',
                    type: 'handler',
                    max_iterations: 1,
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
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'pack-1',
                    type: 'tool_pack',
                    ref_id: '11111111-1111-4111-8111-111111111111',
                    position: { x: 100, y: 160 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                {
                    id: 'pack->h',
                    source: { node_id: 'pack-1' },
                    target: { node_id: 'h1' },
                },
            ],
        };
        const savedL1 = await graphStore.create(l1);

        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'demo',
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
            edges: [
                { id: 'ch->ag', source: { node_id: 'ch' }, target: { node_id: 'ag' } },
                { id: 'ag->ch', source: { node_id: 'ag' }, target: { node_id: 'ch' } },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            modelClientFor: () => ({
                async *complete() {
                    yield { delta: '', finish_reason: 'stop' };
                },
            }),
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
});
