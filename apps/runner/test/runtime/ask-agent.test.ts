import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Edge, Graph, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import {
    ASK_AGENT_DEFAULT_TIMEOUT_MS,
    ASK_AGENT_MAX_CHAIN_DEPTH,
    createAskAgentTool,
    createAskAgentTools,
    type AskAgentBuildCtx,
    type AskAgentDispatchContext,
    type BuiltinToolBuildCtx,
} from '../../src/runtime/builtin-tools.js';
import { newDispatch, childDispatch } from '../../src/runtime/dispatch.js';
import { createDispatchAbortRegistry } from '../../src/runtime/dispatch-aborts.js';
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

const TOOL_CTX = { call_id: 'c1', eventId: 'ev-root' };

function makeFakeCallee(
    bus: ReturnType<typeof createEventBus>,
    args: { topic: string; reply: string; port?: 'result' | 'error' },
): { unsubscribe: () => void; deliveries: DispatchEvent[] } {
    const deliveries: DispatchEvent[] = [];
    const unsubscribe = bus.subscribeTopic(args.topic, async (inbound) => {
        deliveries.push(inbound);
        const child = childDispatch(inbound, {
            messages: [{ role: 'assistant', content: args.reply }],
            meta: { port: args.port ?? 'result' },
        });
        bus.emitDispatch(child);
    });
    return { unsubscribe, deliveries };
}

describe('ask_agent (unit)', () => {
    it('happy path: outbound publishes on edge topic and reply resolves with the callee content', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';
        const edge: Edge = {
            id: 'A->B',
            source: { node_id: callerNodeId },
            target: { node_id: targetNodeId },
        };

        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'caller turn' }],
        });
        const outgoing = [edge];
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext(): AskAgentDispatchContext {
                return {
                    currentDispatch: inbound,
                    outgoing,
                    topicFor: (e) => e.id,
                };
            },
        };

        const tool = createAskAgentTool(buildCtx);
        const callee = makeFakeCallee(bus, { topic: 'A->B', reply: 'callee speaks' });

        const result = await tool.handler(
            { target_agent_id: targetNodeId, brief: 'do the thing' },
            TOOL_CTX,
        );
        callee.unsubscribe();
        expect(result.stdout).toBe('callee speaks');
        expect(result.stderr).toBe('');
        expect(result.exit_code).toBe(0);
        expect(callee.deliveries).toHaveLength(1);
        const delivered = callee.deliveries[0]!;
        expect(delivered.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
        expect(delivered.parentId).toBeUndefined();
        expect(bus.rootEventIdsBySource(delivered.source)).toContain(delivered.eventId);
        expect(bus.rootEventIdsBySourcePrefix(`ask:${callerNodeId}->`)).toContain(
            delivered.eventId,
        );
        expect(result.child_event_id).toBe(delivered.eventId);
    });

    it('errors when the caller has no outgoing edge to the named target', async () => {
        const bus = createEventBus();
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId: 'agent-A',
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [], // no edges
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const r = await tool.handler({ target_agent_id: 'agent-X', brief: 'hi' }, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/no outgoing edge/);
        expect(r.stderr).toMatch(/agent-X/);
    });

    it('times out cleanly when no reply ever arrives', async () => {
        const bus = createEventBus();
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId: 'agent-A',
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    { id: 'A->B', source: { node_id: 'agent-A' }, target: { node_id: 'agent-B' } },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        bus.subscribeTopic('A->B', async () => {
            /* black hole */
        });
        const r = await tool.handler(
            { target_agent_id: 'agent-B', brief: 'hi', timeout_ms: 50 },
            TOOL_CTX,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/timed out after 50ms/);
    });

    it('inherit_session: false → outbound source matches the documented format', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: targetNodeId },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const callee = makeFakeCallee(bus, { topic: 'A->B', reply: 'ok' });

        const r = await tool.handler({ target_agent_id: targetNodeId, brief: 'hi' }, TOOL_CTX);
        callee.unsubscribe();
        expect(r.exit_code).toBe(0);
        const delivered = callee.deliveries[0]!;
        expect(delivered.source).toBe(`ask:${callerNodeId}->${targetNodeId}:${delivered.eventId}`);
        expect(delivered.source).not.toBe(inbound.source);
    });

    it('inherit_session: true → outbound source equals caller session source', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';
        const inbound = newDispatch({
            source: 'channel:user-42',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: targetNodeId },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const callee = makeFakeCallee(bus, { topic: 'A->B', reply: 'ok' });

        const r = await tool.handler(
            { target_agent_id: targetNodeId, brief: 'hi', inherit_session: true },
            TOOL_CTX,
        );
        callee.unsubscribe();
        expect(r.exit_code).toBe(0);
        expect(callee.deliveries[0]!.source).toBe('channel:user-42');
    });

    it('preserves caller meta on the outbound (Step 1 meta merge)', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
            meta: { trace_id: 'corr-123', tenant: 'acme' },
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: targetNodeId },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const callee = makeFakeCallee(bus, { topic: 'A->B', reply: 'ok' });

        const r = await tool.handler({ target_agent_id: targetNodeId, brief: 'hi' }, TOOL_CTX);
        callee.unsubscribe();
        expect(r.exit_code).toBe(0);
        const delivered = callee.deliveries[0]!;
        expect(delivered.meta?.trace_id).toBe('corr-123');
        expect(delivered.meta?.tenant).toBe('acme');
        expect(typeof delivered.meta?.ask_call_id).toBe('string');
    });

    it('stamps ask_caller_node_id and ask_callee_node_id on the outbound meta', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: targetNodeId },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const callee = makeFakeCallee(bus, { topic: 'A->B', reply: 'ok' });

        const r = await tool.handler({ target_agent_id: targetNodeId, brief: 'hi' }, TOOL_CTX);
        callee.unsubscribe();
        expect(r.exit_code).toBe(0);
        const delivered = callee.deliveries[0]!;
        expect(delivered.meta?.ask_caller_node_id).toBe(callerNodeId);
        expect(delivered.meta?.ask_callee_node_id).toBe(targetNodeId);
    });

    it('parallel calls from the same handler resolve to their own replies', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: 'agent-B' },
                    },
                    {
                        id: 'A->C',
                        source: { node_id: callerNodeId },
                        target: { node_id: 'agent-C' },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);

        const calleeB = makeFakeCallee(bus, { topic: 'A->B', reply: 'B-says-hi' });
        const calleeC = makeFakeCallee(bus, { topic: 'A->C', reply: 'C-says-hi' });

        const [rB, rC] = await Promise.all([
            tool.handler({ target_agent_id: 'agent-B', brief: 'b?' }, TOOL_CTX),
            tool.handler({ target_agent_id: 'agent-C', brief: 'c?' }, TOOL_CTX),
        ]);
        calleeB.unsubscribe();
        calleeC.unsubscribe();

        expect(rB.stdout).toBe('B-says-hi');
        expect(rC.stdout).toBe('C-says-hi');
        expect(calleeB.deliveries).toHaveLength(1);
        expect(calleeC.deliveries).toHaveLength(1);
    });

    it('refuses cleanly when no in-flight Dispatch context is available', async () => {
        const bus = createEventBus();
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId: 'agent-A',
            currentContext: () => null,
        };
        const tool = createAskAgentTool(buildCtx);
        const r = await tool.handler({ target_agent_id: 'agent-B', brief: 'hi' }, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/in-flight Dispatch context/);
    });

    it('refuses cleanly when no buildCtx is wired (DebugGateway / unwired path)', async () => {
        const tool = createAskAgentTool(null);
        const r = await tool.handler({ target_agent_id: 'agent-B', brief: 'hi' }, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/in-flight Dispatch context/);
    });

    it('requires target_agent_id and brief', async () => {
        const bus = createEventBus();
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId: 'agent-A',
            currentContext: () => ({
                currentDispatch: newDispatch({ source: 's', messages: [] }),
                outgoing: [],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const r1 = await tool.handler({ brief: 'x' }, TOOL_CTX);
        expect(r1.stderr).toMatch(/target_agent_id/);
        const r2 = await tool.handler({ target_agent_id: 'agent-B' }, TOOL_CTX);
        expect(r2.stderr).toMatch(/brief required/);
    });

    it('exposes ASK_AGENT_DEFAULT_TIMEOUT_MS for callers / future tuning', () => {
        expect(ASK_AGENT_DEFAULT_TIMEOUT_MS).toBe(60_000);
    });
});

describe('ask_agent (cycle + depth guards)', () => {
    function ctxFor(args: {
        callerNodeId: string;
        inbound: DispatchEvent;
        outgoing: Edge[];
    }): AskAgentBuildCtx {
        return {
            bus: createEventBus(),
            callerNodeId: args.callerNodeId,
            currentContext: () => ({
                currentDispatch: args.inbound,
                outgoing: args.outgoing,
                topicFor: (e) => e.id,
            }),
        };
    }

    it('rejects self-ask (agent asking itself)', async () => {
        const callerNodeId = 'agent-A';
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx = ctxFor({
            callerNodeId,
            inbound,
            outgoing: [
                {
                    id: 'A->A',
                    source: { node_id: callerNodeId },
                    target: { node_id: callerNodeId },
                },
            ],
        });
        const tool = createAskAgentTool(buildCtx);
        const r = await tool.handler({ target_agent_id: callerNodeId, brief: 'hi' }, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/cannot ask itself/);
    });

    it('stamps meta.ask_chain on the outbound (caller node id appended)', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: targetNodeId },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const callee = makeFakeCallee(bus, { topic: 'A->B', reply: 'ok' });
        const r = await tool.handler({ target_agent_id: targetNodeId, brief: 'hi' }, TOOL_CTX);
        callee.unsubscribe();
        expect(r.exit_code).toBe(0);
        expect(callee.deliveries[0]!.meta?.ask_chain).toEqual([callerNodeId]);
    });

    it('rejects ancestor-in-chain (A→B→A cycle caught at B)', async () => {
        const inboundToB = newDispatch({
            source: 'ask:agent-A->agent-B:ev-1',
            messages: [{ role: 'user', content: 'B turn' }],
            meta: { ask_chain: ['agent-A'], ask_call_id: 'ask-1' },
        });
        const buildCtx = ctxFor({
            callerNodeId: 'agent-B',
            inbound: inboundToB,
            outgoing: [
                { id: 'B->A', source: { node_id: 'agent-B' }, target: { node_id: 'agent-A' } },
            ],
        });
        const tool = createAskAgentTool(buildCtx);
        const r = await tool.handler({ target_agent_id: 'agent-A', brief: 'back to A?' }, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/cycle/);
        expect(r.stderr).toMatch(/agent-A -> agent-B -> agent-A/);
    });

    it('rejects ancestor-in-chain in a longer cycle (A→B→C→A caught at C)', async () => {
        const inboundToC = newDispatch({
            source: 'ask:agent-B->agent-C:ev-2',
            messages: [{ role: 'user', content: 'C turn' }],
            meta: { ask_chain: ['agent-A', 'agent-B'] },
        });
        const buildCtx = ctxFor({
            callerNodeId: 'agent-C',
            inbound: inboundToC,
            outgoing: [
                { id: 'C->A', source: { node_id: 'agent-C' }, target: { node_id: 'agent-A' } },
            ],
        });
        const tool = createAskAgentTool(buildCtx);
        const r = await tool.handler({ target_agent_id: 'agent-A', brief: 'back?' }, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/cycle/);
        expect(r.stderr).toMatch(/agent-A -> agent-B -> agent-C -> agent-A/);
    });

    it('rejects when chain depth would exceed ASK_AGENT_MAX_CHAIN_DEPTH', async () => {
        const fullChain = Array.from({ length: ASK_AGENT_MAX_CHAIN_DEPTH }, (_, i) => `agent-${i}`);
        const inbound = newDispatch({
            source: 'ask:somewhere:ev',
            messages: [{ role: 'user', content: 'deep turn' }],
            meta: { ask_chain: fullChain },
        });
        const buildCtx = ctxFor({
            callerNodeId: 'agent-leaf',
            inbound,
            outgoing: [
                {
                    id: 'leaf->target',
                    source: { node_id: 'agent-leaf' },
                    target: { node_id: 'agent-target' },
                },
            ],
        });
        const tool = createAskAgentTool(buildCtx);
        const r = await tool.handler(
            { target_agent_id: 'agent-target', brief: 'too deep' },
            TOOL_CTX,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/depth cap exceeded/);
        expect(r.stderr).toMatch(`max ${ASK_AGENT_MAX_CHAIN_DEPTH}`);
    });

    it('allows the maximum-allowed chain depth (boundary at cap is fine)', async () => {
        const priorChain = Array.from(
            { length: ASK_AGENT_MAX_CHAIN_DEPTH - 1 },
            (_, i) => `agent-${i}`,
        );
        const bus = createEventBus();
        const inbound = newDispatch({
            source: 'ask:somewhere:ev',
            messages: [{ role: 'user', content: 'near-cap turn' }],
            meta: { ask_chain: priorChain },
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId: 'agent-leaf',
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'leaf->target',
                        source: { node_id: 'agent-leaf' },
                        target: { node_id: 'agent-target' },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };
        const tool = createAskAgentTool(buildCtx);
        const callee = makeFakeCallee(bus, { topic: 'leaf->target', reply: 'ok' });
        const r = await tool.handler(
            { target_agent_id: 'agent-target', brief: 'still ok' },
            TOOL_CTX,
        );
        callee.unsubscribe();
        expect(r.exit_code).toBe(0);
        expect(callee.deliveries[0]!.meta?.ask_chain).toEqual([...priorChain, 'agent-leaf']);
    });
});

describe('createAskAgentTools (per-callee fan-out)', () => {
    function buildCtxWith(
        reachableAgents: BuiltinToolBuildCtx['reachableAgents'],
        opts: { bus?: ReturnType<typeof createEventBus>; outgoing?: Edge[] } = {},
    ): BuiltinToolBuildCtx {
        const bus = opts.bus ?? createEventBus();
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'caller turn' }],
        });
        const outgoing =
            opts.outgoing ??
            reachableAgents.map((a) => ({
                id: `caller->${a.id}`,
                source: { node_id: 'caller' },
                target: { node_id: a.id },
            }));
        return {
            bus,
            callerNodeId: 'caller',
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing,
                topicFor: (e) => e.id,
            }),
            reachableAgents,
        };
    }

    it('returns [] for a null buildCtx', () => {
        expect(createAskAgentTools(null)).toEqual([]);
    });

    it('returns [] when there are no reachable agents', () => {
        expect(createAskAgentTools(buildCtxWith([]))).toEqual([]);
    });

    it('emits one tool per reachable agent, slugged from the display name', () => {
        const tools = createAskAgentTools(
            buildCtxWith([
                { id: 'n1', displayName: 'Code Writer' },
                { id: 'n2', displayName: 'QA Reviewer!' },
            ]),
        );
        expect(tools.map((t) => t.spec.name)).toEqual([
            'ask_agent_code_writer',
            'ask_agent_qa_reviewer',
        ]);
    });

    it('suffixes collisions (_2, _3) when display names slug identically', () => {
        const tools = createAskAgentTools(
            buildCtxWith([
                { id: 'n1', displayName: 'Coder' },
                { id: 'n2', displayName: 'coder' },
                { id: 'n3', displayName: 'CODER' },
            ]),
        );
        expect(tools.map((t) => t.spec.name)).toEqual([
            'ask_agent_coder',
            'ask_agent_coder_2',
            'ask_agent_coder_3',
        ]);
    });

    it('falls back to the node id slug when the display name slugs empty', () => {
        const tools = createAskAgentTools(
            buildCtxWith([{ id: 'fallback-node', displayName: '!!!' }]),
        );
        expect(tools[0]!.spec.name).toBe('ask_agent_fallback-node');
    });

    it('uses the callee description when set, else a generic fallback', () => {
        const tools = createAskAgentTools(
            buildCtxWith([
                { id: 'n1', displayName: 'Coder', description: 'Writes code from a spec.' },
                { id: 'n2', displayName: 'Helper' },
            ]),
        );
        expect(tools[0]!.spec.description).toBe('Writes code from a spec.');
        expect(tools[1]!.spec.description).toBe('Delegate to Helper.');
    });

    it('drops target_agent_id from the params; brief is required, the rest optional', () => {
        const [tool] = createAskAgentTools(buildCtxWith([{ id: 'n1', displayName: 'Coder' }]));
        const params = tool!.spec.parameters as {
            properties: Record<string, unknown>;
            required: string[];
        };
        expect(Object.keys(params.properties).sort()).toEqual([
            'brief',
            'inherit_session',
            'timeout_ms',
        ]);
        expect(params.properties.target_agent_id).toBeUndefined();
        expect(params.required).toEqual(['brief']);
    });

    it('routes the handler to the correct fixed targetAgentId', async () => {
        const bus = createEventBus();
        const tools = createAskAgentTools(
            buildCtxWith(
                [
                    { id: 'agent-B', displayName: 'B' },
                    { id: 'agent-C', displayName: 'C' },
                ],
                { bus },
            ),
        );
        const calleeB = makeFakeCallee(bus, { topic: 'caller->agent-B', reply: 'B-reply' });
        const calleeC = makeFakeCallee(bus, { topic: 'caller->agent-C', reply: 'C-reply' });

        const toolB = tools.find((t) => t.spec.name === 'ask_agent_b')!;
        const toolC = tools.find((t) => t.spec.name === 'ask_agent_c')!;
        const rB = await toolB.handler({ brief: 'hi B' }, TOOL_CTX);
        const rC = await toolC.handler({ brief: 'hi C' }, TOOL_CTX);
        calleeB.unsubscribe();
        calleeC.unsubscribe();

        expect(rB.stdout).toBe('B-reply');
        expect(rC.stdout).toBe('C-reply');
        expect(calleeB.deliveries).toHaveLength(1);
        expect(calleeC.deliveries).toHaveLength(1);
        expect(calleeB.deliveries[0]!.meta?.ask_callee_node_id).toBe('agent-B');
        expect(calleeC.deliveries[0]!.meta?.ask_callee_node_id).toBe('agent-C');
    });

    it('handler requires a non-empty brief', async () => {
        const [tool] = createAskAgentTools(buildCtxWith([{ id: 'n1', displayName: 'Coder' }]));
        const r = await tool!.handler({}, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/brief required/);
    });
});

describe('ask_agent (publish_failed terminal)', () => {
    it('emits chain.stopped for the outbound eventId when publish throws', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';
        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'x' }],
        });
        const throwingBus = {
            ...bus,
            publish: async () => {
                throw new Error('boom');
            },
        } as unknown as ReturnType<typeof createEventBus>;
        const buildCtx: AskAgentBuildCtx = {
            bus: throwingBus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: targetNodeId },
                    },
                ],
                topicFor: (e) => e.id,
            }),
            reachableAgents: [{ id: targetNodeId, displayName: 'B' }],
        };

        const observed: Array<{ type: string; eventId: string; reason?: string }> = [];
        bus.subscribeObservability((e) =>
            observed.push({
                type: e.type,
                eventId: e.eventId,
                reason: (e as { reason?: string }).reason,
            }),
        );
        let outboundId: string | undefined;
        bus.subscribeDispatch((d) => {
            if (d.meta?.ask_caller_node_id === callerNodeId) outboundId = d.eventId;
        });

        const [tool] = createAskAgentTools(buildCtx);
        const r = await tool!.handler({ brief: 'hi' }, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/publish failed/);
        expect(outboundId).toBeDefined();
        const stopped = observed.find(
            (e) => e.type === 'chain.stopped' && e.eventId === outboundId,
        );
        expect(stopped).toBeDefined();
        expect(stopped!.reason).toBe('ask publish failed');
    });
});

describe('ask_agent (Phase 4 stop cascade)', () => {
    it('stopping the parent aborts the in-flight child AND unblocks the parent wait', async () => {
        const bus = createEventBus();
        const callerNodeId = 'agent-A';
        const targetNodeId = 'agent-B';

        const aborts = createDispatchAbortRegistry();
        const parentEventId = 'parent-ev';
        const parentController = aborts.mint(parentEventId);

        const inbound = newDispatch({
            source: 'channel:c1',
            messages: [{ role: 'user', content: 'caller turn' }],
        });
        const buildCtx: AskAgentBuildCtx = {
            bus,
            callerNodeId,
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [
                    {
                        id: 'A->B',
                        source: { node_id: callerNodeId },
                        target: { node_id: targetNodeId },
                    },
                ],
                topicFor: (e) => e.id,
            }),
        };

        let childController: AbortController | undefined;
        const unsubscribe = bus.subscribeTopic('A->B', async (delivered) => {
            childController = aborts.mint(delivered.eventId, parentEventId);
            // never reply
        });

        const tool = createAskAgentTool(buildCtx);

        const start = Date.now();
        const handlerPromise = tool.handler(
            { target_agent_id: targetNodeId, brief: 'do the thing', timeout_ms: 60_000 },
            { call_id: 'c1', eventId: parentEventId, signal: parentController.signal },
        );
        await new Promise((r) => setTimeout(r, 20));
        aborts.abort(parentEventId);

        const result = await handlerPromise;
        const elapsed = Date.now() - start;
        unsubscribe();

        expect(elapsed).toBeLessThan(1000);
        expect(result.exit_code).toBe(1);
        expect(result.stderr).toBe('[cancelled by user]');
        expect(childController).toBeDefined();
        expect(childController!.signal.aborted).toBe(true);
    });
});

describe('ask_agent (e2e through buildServer)', () => {
    let graphsDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-ask-graphs-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
    });

    it('caller delegates to callee via ask_agent and integrates the reply', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();

        const callerL1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'caller-l1',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h',
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
                    id: 'm',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/gpt',
                    system_prompt: 'caller',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'ask',
                    type: 'tool',
                    tool_name: 'ask_agent',
                    position: { x: 100, y: 160 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h' } },
                { id: 'h->out', source: { node_id: 'h' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm' }, target: { node_id: 'h' } },
                { id: 'ask->h', source: { node_id: 'ask' }, target: { node_id: 'h' } },
            ],
        };
        const savedCallerL1 = await graphStore.create(callerL1);

        const calleeL1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'callee-l1',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h',
                    type: 'handler',
                    name: 'SimpleHandler',
                    max_iterations: 2,
                    position: { x: 100, y: 0 },
                },
                {
                    id: 'out',
                    type: 'output',
                    ports: ['result', 'error'],
                    position: { x: 200, y: 0 },
                },
                {
                    id: 'm',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/gpt',
                    system_prompt: 'callee',
                    position: { x: 100, y: 80 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h' } },
                { id: 'h->out', source: { node_id: 'h' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm' }, target: { node_id: 'h' } },
            ],
        };
        const savedCalleeL1 = await graphStore.create(calleeL1);

        const channelId = 'ch';
        const callerId = 'caller';
        const calleeId = 'callee';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'orch',
            nodes: [
                {
                    id: channelId,
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: callerId,
                    type: 'native_agent',
                    l1_graph_id: savedCallerL1.id!,
                    position: { x: 200, y: 0 },
                },
                {
                    id: calleeId,
                    type: 'native_agent',
                    l1_graph_id: savedCalleeL1.id!,
                    position: { x: 400, y: 0 },
                },
            ],
            edges: [
                {
                    id: 'ch->caller',
                    source: { node_id: channelId },
                    target: { node_id: callerId },
                },
                {
                    id: 'caller->ch',
                    source: { node_id: callerId },
                    target: { node_id: channelId },
                },
                {
                    id: 'caller->callee',
                    source: { node_id: callerId },
                    target: { node_id: calleeId },
                },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const callerClient = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-ask',
                        name: 'ask_agent_callee',
                        arguments: JSON.stringify({
                            brief: 'subtask: write some code',
                        }),
                    },
                ],
            },
            { text: 'final answer integrating: <coder said something>' },
        ]);
        const calleeClient = scriptedClient([{ text: 'coder result' }]);

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            modelClientFor: (node: ModelNode) => {
                if (node.system_prompt === 'caller') return callerClient;
                if (node.system_prompt === 'callee') return calleeClient;
                throw new Error(`unrecognised model node ${node.id}`);
            },
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
                payload: { content: 'please coordinate with the coder' },
            });
            expect(post.statusCode).toBe(202);

            await new Promise((r) => setTimeout(r, 100));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages[0]!.content).toMatch(/final answer/);
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${savedL2.id}/unload` });
            await app.close();
        }
    });

    it('offers no ask_agent tool (so the call fails) when the caller has no agent edge', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();

        const callerL1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'caller-l1',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h',
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
                    id: 'm',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/gpt',
                    system_prompt: 'caller',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'ask',
                    type: 'tool',
                    tool_name: 'ask_agent',
                    position: { x: 100, y: 160 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h' } },
                { id: 'h->out', source: { node_id: 'h' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm' }, target: { node_id: 'h' } },
                { id: 'ask->h', source: { node_id: 'ask' }, target: { node_id: 'h' } },
            ],
        };
        const savedCallerL1 = await graphStore.create(callerL1);

        const channelId = 'ch';
        const callerId = 'caller';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'orch',
            nodes: [
                {
                    id: channelId,
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: callerId,
                    type: 'native_agent',
                    l1_graph_id: savedCallerL1.id!,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [
                {
                    id: 'ch->caller',
                    source: { node_id: channelId },
                    target: { node_id: callerId },
                },
                {
                    id: 'caller->ch',
                    source: { node_id: callerId },
                    target: { node_id: channelId },
                },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const callerClient = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-ask',
                        name: 'ask_agent_no_such_agent',
                        arguments: JSON.stringify({
                            brief: 'whatever',
                        }),
                    },
                ],
            },
            { text: 'I tried but the call failed' },
        ]);

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            modelClientFor: () => callerClient,
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
                payload: { content: 'try the impossible' },
            });
            expect(post.statusCode).toBe(202);
            await new Promise((r) => setTimeout(r, 50));
            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages[0]!.content).toMatch(/I tried but the call failed/);
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${savedL2.id}/unload` });
            await app.close();
        }
    });
});
