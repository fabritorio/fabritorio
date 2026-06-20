import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph, Message, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../../src/server.js';
import { createGraphStore } from '../../../src/graphs/store.js';
import { createMemoryRegistry } from '../../../src/runtime/memory.js';
import { createDebugGatewayRegistry } from '../../../src/runtime/debug.js';
import { createEventBus } from '../../../src/runtime/event-bus.js';
import { childDispatch } from '../../../src/runtime/dispatch.js';
import type { CompleteRequest, ModelClient } from '../../../src/runtime/model.js';
import { inject } from '../../helpers/inject.js';

interface ScriptedReply {
    text?: string;
    tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

function scriptedClient(replies: ScriptedReply[]): {
    client: ModelClient;
    captured: CompleteRequest[];
} {
    const captured: CompleteRequest[] = [];
    let i = 0;
    const client: ModelClient = {
        async *complete(req) {
            // Snapshot the messages at call time: the handler graph mutates the
            // live `messages` array after the call returns (it appends the
            // assistant reply), so a by-reference capture would otherwise show
            // post-call state.
            captured.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
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
    return { client, captured };
}

function buildL1(opts: { gatewayId: string }): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l1',
        name: 'debug-l1',
        nodes: [
            {
                id: opts.gatewayId,
                type: 'debug_gateway',
                mode: 'live',
                position: { x: -100, y: 0 },
            },
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
                system_prompt: 'L1 system prompt.',
                position: { x: 100, y: 80 },
            },
        ],
        edges: [
            { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
            { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
            { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
        ],
    };
}

describe("DebugGateway L1 mode picks up parent NativeAgent's Memory", () => {
    let graphsDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-debug-gateway-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
    });

    it('merges prior session history from the parent L2 Memory', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const memoryRegistry = createMemoryRegistry();
        const debugGatewayRegistry = createDebugGatewayRegistry();
        const { client, captured } = scriptedClient([{ text: 'echo 1' }]);

        const gatewayId = 'dbg-1';
        const savedL1 = await graphStore.create(buildL1({ gatewayId }));

        const agentId = 'ag-1';
        const memoryId = 'mem-1';
        const sessionKey = 'debug:dbg-1';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'parent-l2',
            nodes: [
                {
                    id: agentId,
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 0, y: 0 },
                },
                {
                    id: memoryId,
                    type: 'memory',
                    storage: 'in_memory',
                    storage_kind: 'kv',
                    handling: 'full_history',
                    tool_access: 'none',
                    position: { x: 200, y: 120 },
                },
            ],
            edges: [
                {
                    id: 'mem->ag',
                    source: { node_id: memoryId },
                    target: { node_id: agentId },
                },
            ],
        };
        await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            memoryRegistry,
            debugGatewayRegistry,
            modelClientFor: (_node: ModelNode) => client,
        });

        const loadL2 = await inject(app, {
            method: 'POST',
            url: `/api/graphs/${(await graphStore.list()).find((g) => g.kind === 'l2')!.id}/load`,
        });
        expect(loadL2.statusCode).toBe(200);

        const memHandle = memoryRegistry.get(memoryId)!;
        const prior: Message[] = [
            { role: 'user', content: 'remember: my color is blue' },
            { role: 'assistant', content: 'noted, blue.' },
        ];
        memHandle.write(sessionKey, prior);

        const loadL1 = await inject(app, {
            method: 'POST',
            url: `/api/graphs/${savedL1.id}/load`,
        });
        expect(loadL1.statusCode).toBe(200);

        const handle = debugGatewayRegistry.get(savedL1.id!, gatewayId);
        expect(handle).toBeDefined();
        await handle!.publish({ content: 'what color did i pick?' });

        expect(captured).toHaveLength(1);
        const userMsgs = captured[0]!.messages.filter((m) => m.role === 'user');
        expect(userMsgs.map((m) => m.content)).toEqual([
            'remember: my color is blue',
            'what color did i pick?',
        ]);

        const after = memHandle.read(sessionKey) as Message[];
        expect(after).toHaveLength(4);
        expect(after[3]).toEqual({ role: 'assistant', content: 'echo 1' });

        await app.close();
    });

    it('renders parent context-purpose Memory into the system prompt', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const memoryRegistry = createMemoryRegistry();
        const debugGatewayRegistry = createDebugGatewayRegistry();
        const { client, captured } = scriptedClient([{ text: 'ack' }]);

        const gatewayId = 'dbg-ctx';
        const savedL1 = await graphStore.create(buildL1({ gatewayId }));

        const agentId = 'ag-ctx';
        const ctxMemId = 'mem-ctx';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'parent-l2-ctx',
            nodes: [
                {
                    id: agentId,
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 0, y: 0 },
                },
                {
                    id: ctxMemId,
                    type: 'memory',
                    storage: 'in_memory',
                    storage_kind: 'static_string',
                    handling: 'always_inject',
                    tool_access: 'none',
                    content: 'Always answer in haiku.',
                    position: { x: 200, y: 120 },
                },
            ],
            edges: [
                {
                    id: 'ctx->ag',
                    source: { node_id: ctxMemId },
                    target: { node_id: agentId },
                },
            ],
        };
        await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            memoryRegistry,
            debugGatewayRegistry,
            modelClientFor: (_node: ModelNode) => client,
        });

        const load = await inject(app, {
            method: 'POST',
            url: `/api/graphs/${savedL1.id}/load`,
        });
        expect(load.statusCode).toBe(200);

        const handle = debugGatewayRegistry.get(savedL1.id!, gatewayId);
        await handle!.publish({ content: 'hello' });

        expect(captured).toHaveLength(1);
        const systemMsg = captured[0]!.messages.find((m) => m.role === 'system');
        expect(systemMsg?.content).toContain('Always answer in haiku.');

        await app.close();
    });

    it("resolves the wired session Memory handle even when the parent L2 isn't loaded", async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const memoryRegistry = createMemoryRegistry();
        const debugGatewayRegistry = createDebugGatewayRegistry();
        const { client, captured } = scriptedClient([
            { text: 'first reply' },
            { text: 'second reply' },
        ]);

        const gatewayId = 'dbg-noload';
        const savedL1 = await graphStore.create(buildL1({ gatewayId }));

        const agentId = 'ag-noload';
        const memoryId = 'mem-noload';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'parent-l2-noload',
            nodes: [
                {
                    id: agentId,
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 0, y: 0 },
                },
                {
                    id: memoryId,
                    type: 'memory',
                    storage: 'in_memory',
                    storage_kind: 'kv',
                    handling: 'full_history',
                    tool_access: 'none',
                    position: { x: 200, y: 120 },
                },
            ],
            edges: [
                {
                    id: 'mem->ag',
                    source: { node_id: memoryId },
                    target: { node_id: agentId },
                },
            ],
        };
        await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            memoryRegistry,
            debugGatewayRegistry,
            modelClientFor: (_node: ModelNode) => client,
        });

        const loadL1 = await inject(app, {
            method: 'POST',
            url: `/api/graphs/${savedL1.id}/load`,
        });
        expect(loadL1.statusCode).toBe(200);

        expect(memoryRegistry.get(memoryId)).toBeDefined();

        const handle = debugGatewayRegistry.get(savedL1.id!, gatewayId);
        expect(handle).toBeDefined();
        await handle!.publish({ content: 'remember: dogs are good' });
        await handle!.publish({ content: 'what did i ask you to remember?' });

        expect(captured).toHaveLength(2);
        expect(
            captured[1]!.messages.filter((m) => m.role === 'user').map((m) => m.content),
        ).toEqual(['remember: dogs are good', 'what did i ask you to remember?']);
        expect(
            captured[1]!.messages.filter((m) => m.role === 'assistant').map((m) => m.content),
        ).toEqual(['first reply']);

        await app.close();
    });

    it('falls back to a scratch (no-memory) session when the L1 is orphaned', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const memoryRegistry = createMemoryRegistry();
        const debugGatewayRegistry = createDebugGatewayRegistry();
        const { client, captured } = scriptedClient([{ text: 'ok' }]);

        const gatewayId = 'dbg-orphan';
        const savedL1 = await graphStore.create(buildL1({ gatewayId }));

        const app = buildServer({
            logger: false,
            graphStore,
            memoryRegistry,
            debugGatewayRegistry,
            modelClientFor: (_node: ModelNode) => client,
        });

        const load = await inject(app, {
            method: 'POST',
            url: `/api/graphs/${savedL1.id}/load`,
        });
        expect(load.statusCode).toBe(200);

        const handle = debugGatewayRegistry.get(savedL1.id!, gatewayId);
        expect(handle).toBeDefined();
        await handle!.publish({ content: 'first' });
        expect(captured).toHaveLength(1);
        expect(memoryRegistry.list()).toHaveLength(0);

        await app.close();
    });

    it('drives ask_agent under the PARENT agent identity + L2 edges when a parent L2 exists', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const memoryRegistry = createMemoryRegistry();
        const debugGatewayRegistry = createDebugGatewayRegistry();
        const bus = createEventBus();
        const { client } = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-ask',
                        name: 'ask_agent_callee',
                        arguments: JSON.stringify({
                            brief: 'do the subtask',
                        }),
                    },
                ],
            },
            { text: 'integrated reply' },
        ]);

        const gatewayId = 'dbg-ask';
        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'debug-l1-ask',
            nodes: [
                { id: gatewayId, type: 'debug_gateway', mode: 'live', position: { x: -100, y: 0 } },
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
                    system_prompt: 'L1 system prompt.',
                    position: { x: 100, y: 80 },
                },
                { id: 'ask', type: 'tool', tool_name: 'ask_agent', position: { x: 100, y: 160 } },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                { id: 'ask->h', source: { node_id: 'ask' }, target: { node_id: 'h1' } },
            ],
        };
        const savedL1 = await graphStore.create(l1);

        const agentId = 'parent-agent';
        const edgeId = 'parent->callee';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'parent-l2-ask',
            nodes: [
                {
                    id: agentId,
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'callee',
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [
                {
                    id: edgeId,
                    source: { node_id: agentId },
                    target: { node_id: 'callee' },
                },
            ],
        };
        await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            memoryRegistry,
            debugGatewayRegistry,
            bus,
            modelClientFor: (_node: ModelNode) => client,
        });

        const seen: DispatchEvent[] = [];
        bus.subscribeTopic(edgeId, async (inbound) => {
            seen.push(inbound);
            bus.emitDispatch(
                childDispatch(inbound, {
                    messages: [{ role: 'assistant', content: 'callee result' }],
                    meta: { port: 'result' },
                }),
            );
        });

        const loadL1 = await inject(app, {
            method: 'POST',
            url: `/api/graphs/${savedL1.id}/load`,
        });
        expect(loadL1.statusCode).toBe(200);

        const handle = debugGatewayRegistry.get(savedL1.id!, gatewayId);
        expect(handle).toBeDefined();
        await handle!.publish({ content: 'coordinate with the callee' });
        await new Promise((r) => setTimeout(r, 50));

        expect(seen).toHaveLength(1);
        expect(seen[0]!.meta?.ask_caller_node_id).toBe(agentId);
        expect(seen[0]!.meta?.ask_callee_node_id).toBe('callee');

        await app.close();
    });
});
