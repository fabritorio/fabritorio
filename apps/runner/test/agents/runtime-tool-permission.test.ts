import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { createRuntimeToolRegistry } from '../../src/runtime/runtime-tools.js';
import { createPermissionGateRegistry } from '../../src/runtime/permission.js';
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

describe('runtime tool permission gating', () => {
    let graphsDir: string;
    let toolsRoot: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-rt-perm-graphs-'));
        toolsRoot = mkdtempSync(join(tmpdir(), 'fabritorio-rt-perm-tools-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(toolsRoot, { recursive: true, force: true });
    });

    function seedEchoTool(): void {
        const dir = join(toolsRoot, 'rt_echo');
        mkdirSync(dir, { recursive: true });
        const bin = join(dir, 'rt_echo');
        writeFileSync(bin, '#!/usr/bin/env bash\necho "${2:-default}"\n', 'utf8');
        chmodSync(bin, 0o755);
        writeFileSync(
            join(dir, 'manifest.json'),
            JSON.stringify({
                name: 'rt_echo',
                description: 'echo a message',
                parameters: {
                    type: 'object',
                    properties: { message: { type: 'string' } },
                    required: ['message'],
                    additionalProperties: false,
                },
                adapter: 'bash_cli',
                adapter_config: {
                    binary: 'rt_echo',
                    arg_style: 'flags',
                    arg_mapping: { message: '--message' },
                },
            }),
            'utf8',
        );
    }

    function buildL2(l1Id: string): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
        return {
            kind: 'l2',
            name: 'rt-perm-demo',
            nodes: [
                {
                    id: 'ch-rt',
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'ag-rt',
                    type: 'native_agent',
                    l1_graph_id: l1Id,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [
                { id: 'ch->ag', source: { node_id: 'ch-rt' }, target: { node_id: 'ag-rt' } },
                { id: 'ag->ch', source: { node_id: 'ag-rt' }, target: { node_id: 'ch-rt' } },
            ],
        };
    }

    function buildL1(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
        return {
            kind: 'l1',
            name: 'rt-perm-l1',
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
                    system_prompt: 'be terse',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'tool-rt',
                    type: 'tool',
                    tool_name: 'rt_echo',
                    position: { x: 0, y: 160 },
                },
                {
                    id: 'perm',
                    type: 'permission',
                    position: { x: 100, y: 160 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                { id: 'tool->perm', source: { node_id: 'tool-rt' }, target: { node_id: 'perm' } },
                { id: 'perm->h', source: { node_id: 'perm' }, target: { node_id: 'h1' } },
            ],
        };
    }

    it('fires the PermissionNode before the bash_cli adapter executes', async () => {
        seedEchoTool();
        const graphStore = createGraphStore({ dir: graphsDir });
        await graphStore.seed(DEFAULT_SIMPLE_HANDLER_ID, buildDefaultSimpleHandlerGraph());
        const savedL1 = await graphStore.create(buildL1());
        const savedL2 = await graphStore.create(buildL2(savedL1.id!));

        const channels = createChannelRegistry();
        const runtimeToolRegistry = createRuntimeToolRegistry([toolsRoot]);
        const permissionGateRegistry = createPermissionGateRegistry();

        const model = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-1',
                        name: 'rt_echo',
                        arguments: JSON.stringify({ message: 'hi' }),
                    },
                ],
            },
            { text: 'ok-after-denial' },
        ]);
        const captured: CompleteRequest[] = [];
        const wrapped: ModelClient = {
            async *complete(req) {
                captured.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
                yield* model.complete(req);
            },
        };

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            runtimeToolRegistry,
            permissionGateRegistry,
            modelClientFor: (_node: ModelNode) => wrapped,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            const channel = channels.get('ch-rt')!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((e) => {
                if (e.messages?.[0]?.role !== 'user') replies.push(e);
            });

            const decisions: Array<{ callId: string; toolName: string }> = [];
            const gate = permissionGateRegistry.get(savedL1.id!, 'perm');
            expect(gate).toBeDefined();
            const unsub = gate!.subscribe((req) => {
                decisions.push({ callId: req.callId, toolName: req.toolName });
                queueMicrotask(() => gate!.decide(req.callId, 'deny'));
            });

            const post = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/ch-rt/message`,
                payload: { content: 'please echo hi' },
            });
            expect(post.statusCode).toBe(202);

            await new Promise((r) => setTimeout(r, 80));
            unsub();

            expect(decisions).toEqual([{ callId: 'call-1', toolName: 'rt_echo' }]);

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages).toEqual([
                { role: 'assistant', content: 'ok-after-denial' },
            ]);

            expect(captured).toHaveLength(2);
            const secondMessages = captured[1]!.messages;
            const toolMsg = secondMessages[secondMessages.length - 1]!;
            expect(toolMsg).toMatchObject({
                role: 'tool',
                tool_call_id: 'call-1',
            });
            const toolText = typeof toolMsg.content === 'string' ? toolMsg.content : '';
            expect(toolText).toMatch(/denied by user/);
            expect(toolText).not.toMatch(/hi/);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/unload`,
            });
            await app.close();
        }
    });
});
