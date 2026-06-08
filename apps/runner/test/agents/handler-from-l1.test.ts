import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Graph, ModelNode, ObservabilityEvent } from '@fabritorio/types';
import { buildHandlerFromL1 } from '../../src/runtime/agents/handler-from-l1.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { newDispatch } from '../../src/runtime/dispatch.js';
import type { BuiltinToolBuildCtx } from '../../src/runtime/builtin-tools.js';
import {
    DEFAULT_SIMPLE_HANDLER_ID,
    seedDefaultHandlerGraph,
} from '../../src/runtime/handlers/default-graph.js';
import { createDefaultHandlerRegistry } from '../../src/runtime/handlers/registry.js';
import { createSkillRegistry } from '../../src/runtime/skills.js';
import { createSecretsStore } from '../../src/runtime/secrets-store.js';
import type { CompleteRequest, ModelClient } from '../../src/runtime/model.js';

interface ScriptedTurn {
    text?: string;
    finish_reason?: string;
    throwStatus?: number;
}

function scriptedClient(turns: ScriptedTurn[]): {
    client: ModelClient;
    calls: CompleteRequest[];
} {
    const calls: CompleteRequest[] = [];
    let i = 0;
    return {
        calls,
        client: {
            async *complete(req) {
                calls.push(req);
                const turn = turns[i++];
                if (!turn) throw new Error('scripted client exhausted');
                if (turn.throwStatus !== undefined) {
                    const err = new Error(`http ${turn.throwStatus}`) as Error & {
                        status: number;
                    };
                    err.status = turn.throwStatus;
                    throw err;
                }
                if (turn.text) yield { delta: turn.text };
                yield { delta: '', finish_reason: turn.finish_reason ?? 'stop' };
            },
        },
    };
}

function buildL1WithRouter(extra: {
    routerEdges: Array<{ source: string; priority?: number }>;
}): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const edges: Graph['edges'] = [
        { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
        { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
        { id: 'h->r', source: { node_id: 'h1' }, target: { node_id: 'r1' } },
    ];
    for (const e of extra.routerEdges) {
        edges.push({
            id: `r->${e.source}`,
            source: { node_id: 'r1' },
            target: { node_id: e.source },
            ...(e.priority !== undefined ? { priority: e.priority } : {}),
        });
    }
    return {
        kind: 'l1',
        nodes: [
            { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
            { id: 'h1', type: 'handler', name: 'SimpleHandler', position: { x: 100, y: 0 } },
            { id: 'out', type: 'output', position: { x: 200, y: 0 } },
            { id: 'r1', type: 'model_router', policy: 'failover', position: { x: 0, y: 80 } },
            {
                id: 'mA',
                type: 'model',
                provider: 'fake',
                model_id: 'fake/A',
                system_prompt: 'you are A',
                position: { x: 100, y: 160 },
            },
            {
                id: 'mB',
                type: 'model',
                provider: 'fake',
                model_id: 'fake/B',
                position: { x: 200, y: 160 },
            },
        ],
        edges,
    };
}

describe('buildHandlerFromL1 — ModelRouter wiring', () => {
    let graphsDir: string;

    function withSetup(): {
        graphStore: ReturnType<typeof createGraphStore>;
        cleanup: () => void;
    } {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-handler-from-l1-'));
        return {
            graphStore: createGraphStore({ dir: graphsDir }),
            cleanup: () => rmSync(graphsDir, { recursive: true, force: true }),
        };
    }

    it('Router + 2 Models → builds and dispatches via priority-0 Model', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const l1: Graph = {
                ...buildL1WithRouter({
                    routerEdges: [
                        { source: 'mA', priority: 0 },
                        { source: 'mB', priority: 1 },
                    ],
                }),
                id: 'l1-1',
            };

            const aSink = scriptedClient([{ text: 'reply-from-A' }]);
            const bSink = scriptedClient([{ text: 'reply-from-B' }]);

            const built = await buildHandlerFromL1(l1, {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: (node: ModelNode) =>
                    node.id === 'mA' ? aSink.client : bSink.client,
            });

            const result = await built.handler.run([{ role: 'user', content: 'hi' }], {
                eventId: 'ev-1',
            });

            expect(result.errored).toBe(false);
            expect(result.output.content).toBe('reply-from-A');
            expect(aSink.calls).toHaveLength(1);
            expect(aSink.calls[0]!.model).toBe('fake/A');
            expect(bSink.calls).toHaveLength(0);
            expect(aSink.calls[0]!.messages[0]).toEqual({
                role: 'system',
                content: 'you are A',
            });
        } finally {
            cleanup();
        }
    });

    it('priority-0 Model fails pre-stream → falls through to priority-1', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const l1: Graph = {
                ...buildL1WithRouter({
                    routerEdges: [
                        { source: 'mA', priority: 0 },
                        { source: 'mB', priority: 1 },
                    ],
                }),
                id: 'l1-2',
            };

            const aSink = scriptedClient([{ throwStatus: 429 }]);
            const bSink = scriptedClient([{ text: 'B-recovered' }]);

            const built = await buildHandlerFromL1(l1, {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: (node: ModelNode) =>
                    node.id === 'mA' ? aSink.client : bSink.client,
            });

            const result = await built.handler.run([{ role: 'user', content: 'hi' }], {
                eventId: 'ev-2',
            });

            expect(result.errored).toBe(false);
            expect(result.output.content).toBe('B-recovered');
            expect(aSink.calls).toHaveLength(1);
            expect(bSink.calls).toHaveLength(1);
            expect(bSink.calls[0]!.model).toBe('fake/B');
        } finally {
            cleanup();
        }
    });

    it('edge priorities [undefined, 0] → priority 0 wins, undefined sorts last', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const l1: Graph = {
                ...buildL1WithRouter({
                    routerEdges: [{ source: 'mA' }, { source: 'mB', priority: 0 }],
                }),
                id: 'l1-3',
            };

            const aSink = scriptedClient([{ text: 'A' }]);
            const bSink = scriptedClient([{ text: 'B-wins' }]);

            const built = await buildHandlerFromL1(l1, {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: (node: ModelNode) =>
                    node.id === 'mA' ? aSink.client : bSink.client,
            });

            const result = await built.handler.run([{ role: 'user', content: 'hi' }], {
                eventId: 'ev-3',
            });

            expect(result.output.content).toBe('B-wins');
            expect(bSink.calls).toHaveLength(1);
            expect(aSink.calls).toHaveLength(0);
        } finally {
            cleanup();
        }
    });

    it('ModelRouter with zero children → build throws clear message', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const l1: Graph = {
                ...buildL1WithRouter({ routerEdges: [] }),
                id: 'l1-4',
                // Strip the mA / mB nodes too — they exist in the helper output
                // but aren't wired. Throwing is about the router itself having
                // zero wired children, not about node presence.
            };
            l1.nodes = l1.nodes.filter((n) => n.id !== 'mA' && n.id !== 'mB');

            await expect(
                buildHandlerFromL1(l1, {
                    graphStore,
                    skillRegistry: createSkillRegistry([]),
                    handlerRegistry: createDefaultHandlerRegistry(),
                    modelClientFor: () => ({
                        async *complete() {},
                    }),
                }),
            ).rejects.toThrow(/ModelRouter r1 has no Models wired/);
        } finally {
            cleanup();
        }
    });

    it('Handler with no Model and no Router → throws "Handler has no Model wired"', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const l1: Graph = {
                kind: 'l1',
                id: 'l1-5',
                nodes: [
                    { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                    {
                        id: 'h1',
                        type: 'handler',
                        name: 'SimpleHandler',
                        position: { x: 100, y: 0 },
                    },
                    { id: 'out', type: 'output', position: { x: 200, y: 0 } },
                ],
                edges: [
                    { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                    { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                ],
            };

            await expect(
                buildHandlerFromL1(l1, {
                    graphStore,
                    skillRegistry: createSkillRegistry([]),
                    handlerRegistry: createDefaultHandlerRegistry(),
                    modelClientFor: () => ({
                        async *complete() {},
                    }),
                }),
            ).rejects.toThrow(/Handler has no Model wired/);
        } finally {
            cleanup();
        }
    });

    it('nested Router-of-Router → builds, dispatches via deepest priority-0 Model', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const l1: Graph = {
                kind: 'l1',
                id: 'l1-6',
                nodes: [
                    { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                    {
                        id: 'h1',
                        type: 'handler',
                        name: 'SimpleHandler',
                        position: { x: 100, y: 0 },
                    },
                    { id: 'out', type: 'output', position: { x: 200, y: 0 } },
                    {
                        id: 'r1',
                        type: 'model_router',
                        policy: 'failover',
                        position: { x: 0, y: 80 },
                    },
                    {
                        id: 'r2',
                        type: 'model_router',
                        policy: 'failover',
                        position: { x: 0, y: 160 },
                    },
                    {
                        id: 'mA',
                        type: 'model',
                        provider: 'fake',
                        model_id: 'fake/A',
                        system_prompt: 'A-prompt',
                        position: { x: 100, y: 240 },
                    },
                    {
                        id: 'mB',
                        type: 'model',
                        provider: 'fake',
                        model_id: 'fake/B',
                        position: { x: 200, y: 240 },
                    },
                    {
                        id: 'mC',
                        type: 'model',
                        provider: 'fake',
                        model_id: 'fake/C',
                        position: { x: 300, y: 240 },
                    },
                ],
                edges: [
                    { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                    { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                    { id: 'h->r1', source: { node_id: 'h1' }, target: { node_id: 'r1' } },
                    {
                        id: 'r1->r2',
                        source: { node_id: 'r1' },
                        target: { node_id: 'r2' },
                        priority: 0,
                    },
                    {
                        id: 'r1->mC',
                        source: { node_id: 'r1' },
                        target: { node_id: 'mC' },
                        priority: 1,
                    },
                    {
                        id: 'r2->mA',
                        source: { node_id: 'r2' },
                        target: { node_id: 'mA' },
                        priority: 0,
                    },
                    {
                        id: 'r2->mB',
                        source: { node_id: 'r2' },
                        target: { node_id: 'mB' },
                        priority: 1,
                    },
                ],
            };

            const aSink = scriptedClient([{ text: 'A-deep' }]);
            const bSink = scriptedClient([{ text: 'B' }]);
            const cSink = scriptedClient([{ text: 'C' }]);

            const built = await buildHandlerFromL1(l1, {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: (node: ModelNode) => {
                    if (node.id === 'mA') return aSink.client;
                    if (node.id === 'mB') return bSink.client;
                    return cSink.client;
                },
            });

            const result = await built.handler.run([{ role: 'user', content: 'hi' }], {
                eventId: 'ev-6',
            });

            expect(result.output.content).toBe('A-deep');
            expect(aSink.calls).toHaveLength(1);
            expect(aSink.calls[0]!.model).toBe('fake/A');
            expect(aSink.calls[0]!.messages[0]).toEqual({
                role: 'system',
                content: 'A-prompt',
            });
            expect(bSink.calls).toHaveLength(0);
            expect(cSink.calls).toHaveLength(0);
        } finally {
            cleanup();
        }
    });

    it('router events land on the observability bus in order, stamped with eventId + Router node_id', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            await seedDefaultHandlerGraph(graphStore);

            const l1: Graph = {
                kind: 'l1',
                id: 'l1-bridge',
                nodes: [
                    { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                    {
                        id: 'h1',
                        type: 'handler',
                        name: 'SimpleHandler',
                        ref_id: DEFAULT_SIMPLE_HANDLER_ID,
                        position: { x: 100, y: 0 },
                    },
                    { id: 'out', type: 'output', position: { x: 200, y: 0 } },
                    {
                        id: 'r1',
                        type: 'model_router',
                        policy: 'failover',
                        position: { x: 0, y: 80 },
                    },
                    {
                        id: 'mA',
                        type: 'model',
                        provider: 'fake',
                        model_id: 'fake/A',
                        system_prompt: 'be brief',
                        position: { x: 100, y: 160 },
                    },
                    {
                        id: 'mB',
                        type: 'model',
                        provider: 'fake',
                        model_id: 'fake/B',
                        position: { x: 200, y: 160 },
                    },
                ],
                edges: [
                    { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                    { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                    { id: 'h->r', source: { node_id: 'h1' }, target: { node_id: 'r1' } },
                    {
                        id: 'r->mA',
                        source: { node_id: 'r1' },
                        target: { node_id: 'mA' },
                        priority: 0,
                    },
                    {
                        id: 'r->mB',
                        source: { node_id: 'r1' },
                        target: { node_id: 'mB' },
                        priority: 1,
                    },
                ],
            };

            const aClient: ModelClient = {
                // eslint-disable-next-line require-yield
                async *complete() {
                    throw Object.assign(new Error('rate'), { status: 429 });
                },
            };
            const bClient: ModelClient = {
                async *complete() {
                    yield { delta: 'hello' };
                    yield { delta: '', finish_reason: 'stop' };
                },
            };

            const built = await buildHandlerFromL1(l1, {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: (node: ModelNode) => (node.id === 'mA' ? aClient : bClient),
            });

            const events: ObservabilityEvent[] = [];
            const result = await built.handler.run([{ role: 'user', content: 'hi' }], {
                eventId: 'ev-bridge',
                emitObservability: (e) => events.push(e),
            });

            expect(result.errored).toBe(false);
            expect(result.output.content).toBe('hello');

            const filtered = events.filter((e) =>
                /^model_router\.|^llm\.(request|response)$/.test(e.type),
            );
            const types = filtered.map((e) => e.type);
            expect(types).toEqual([
                'llm.request',
                'model_router.attempted',
                'model_router.fell_through',
                'model_router.attempted',
                'llm.response',
            ]);

            const attempted0 = filtered[1]!;
            if (attempted0.type !== 'model_router.attempted') throw new Error('type guard');
            expect(attempted0.model_node_id).toBe('mA');
            expect(attempted0.attempt).toBe(0);

            const fellThrough = filtered[2]!;
            if (fellThrough.type !== 'model_router.fell_through') throw new Error('type guard');
            expect(fellThrough.from_model_node_id).toBe('mA');
            expect(fellThrough.to_model_node_id).toBe('mB');
            expect(fellThrough.reason).toContain('429');

            const attempted1 = filtered[3]!;
            if (attempted1.type !== 'model_router.attempted') throw new Error('type guard');
            expect(attempted1.model_node_id).toBe('mB');
            expect(attempted1.attempt).toBe(1);

            const routerEvents = events.filter((e) => e.type.startsWith('model_router.'));
            expect(routerEvents).toHaveLength(3);
            for (const re of routerEvents) {
                expect(re.eventId).toBe('ev-bridge');
                expect(re.node_id).toBe('r1');
            }
        } finally {
            cleanup();
        }
    });
});

describe('buildHandlerFromL1 — ask_agent per-callee expansion', () => {
    let graphsDir: string;

    function withSetup(): {
        graphStore: ReturnType<typeof createGraphStore>;
        cleanup: () => void;
    } {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-handler-ask-'));
        return {
            graphStore: createGraphStore({ dir: graphsDir }),
            cleanup: () => rmSync(graphsDir, { recursive: true, force: true }),
        };
    }

    function askAgentL1(): Graph {
        return {
            kind: 'l1',
            id: 'l1-ask',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'h1', type: 'handler', name: 'SimpleHandler', position: { x: 100, y: 0 } },
                { id: 'out', type: 'output', position: { x: 200, y: 0 } },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/A',
                    system_prompt: 'caller',
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
    }

    function buildCtxWith(
        reachableAgents: BuiltinToolBuildCtx['reachableAgents'],
    ): BuiltinToolBuildCtx {
        const bus = createEventBus();
        const inbound = newDispatch({ source: 's', messages: [] });
        return {
            bus,
            callerNodeId: 'caller',
            currentContext: () => ({
                currentDispatch: inbound,
                outgoing: [],
                topicFor: (e) => e.id,
            }),
            reachableAgents,
        };
    }

    it('two reachable callees → two ask_agent_* tools, no free-form ask_agent', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const sink = scriptedClient([{ text: 'done' }]);
            const built = await buildHandlerFromL1(askAgentL1(), {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: () => sink.client,
                builtinToolBuildCtx: buildCtxWith([
                    { id: 'n1', displayName: 'Coder' },
                    { id: 'n2', displayName: 'Reviewer' },
                ]),
            });

            await built.handler.run([{ role: 'user', content: 'hi' }], { eventId: 'ev-ask' });

            const toolNames = (sink.calls[0]!.tools ?? []).map((t) => t.name);
            expect(toolNames).toContain('ask_agent_coder');
            expect(toolNames).toContain('ask_agent_reviewer');
            expect(toolNames).not.toContain('ask_agent');
        } finally {
            cleanup();
        }
    });

    it('no reachable callees → no ask_agent tool at all', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const sink = scriptedClient([{ text: 'done' }]);
            const built = await buildHandlerFromL1(askAgentL1(), {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: () => sink.client,
                builtinToolBuildCtx: buildCtxWith([]),
            });

            await built.handler.run([{ role: 'user', content: 'hi' }], { eventId: 'ev-ask-none' });

            const toolNames = (sink.calls[0]!.tools ?? []).map((t) => t.name);
            expect(toolNames.filter((n) => n.startsWith('ask_agent'))).toEqual([]);
        } finally {
            cleanup();
        }
    });
});

describe('buildHandlerFromL1 — ToolNode config threading (fetch pin)', () => {
    let graphsDir: string;

    function withSetup(): {
        graphStore: ReturnType<typeof createGraphStore>;
        cleanup: () => void;
    } {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-handler-fetch-'));
        return {
            graphStore: createGraphStore({ dir: graphsDir }),
            cleanup: () => rmSync(graphsDir, { recursive: true, force: true }),
        };
    }

    function fetchL1(config?: Record<string, unknown>): Graph {
        return {
            kind: 'l1',
            id: 'l1-fetch',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'h1', type: 'handler', name: 'SimpleHandler', position: { x: 100, y: 0 } },
                { id: 'out', type: 'output', position: { x: 200, y: 0 } },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/A',
                    system_prompt: 'caller',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'fetch',
                    type: 'tool',
                    tool_name: 'web_fetch',
                    position: { x: 100, y: 160 },
                    ...(config ? { config } : {}),
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                { id: 'fetch->h', source: { node_id: 'fetch' }, target: { node_id: 'h1' } },
            ],
        };
    }

    it('a fetch ToolNode resolves and advertises the fetch tool to the model', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const sink = scriptedClient([{ text: 'done' }]);
            const built = await buildHandlerFromL1(fetchL1(), {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: () => sink.client,
            });
            await built.handler.run([{ role: 'user', content: 'hi' }], { eventId: 'ev-fetch' });

            const fetchTool = (sink.calls[0]!.tools ?? []).find((t) => t.name === 'web_fetch');
            expect(fetchTool).toBeDefined();
            const props = (fetchTool!.parameters as { properties: Record<string, unknown> })
                .properties;
            expect(Object.keys(props).sort()).toEqual(['mode', 'selector', 'url']);
        } finally {
            cleanup();
        }
    });

    it('config { mode: "markdown" } pins the mode → model-facing schema omits `mode`', async () => {
        const { graphStore, cleanup } = withSetup();
        try {
            const sink = scriptedClient([{ text: 'done' }]);
            const built = await buildHandlerFromL1(fetchL1({ mode: 'markdown' }), {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: () => sink.client,
            });
            await built.handler.run([{ role: 'user', content: 'hi' }], {
                eventId: 'ev-fetch-pin',
            });

            const fetchTool = (sink.calls[0]!.tools ?? []).find((t) => t.name === 'web_fetch');
            expect(fetchTool).toBeDefined();
            const params = fetchTool!.parameters as {
                properties: Record<string, unknown>;
                required: string[];
            };
            expect(params.properties).not.toHaveProperty('mode');
            expect(params.properties).toHaveProperty('url');
            expect(params.required).not.toContain('mode');
        } finally {
            cleanup();
        }
    });
});

describe('buildHandlerFromL1 — web_search secret binding', () => {
    let graphsDir: string;
    let secretsPath: string;

    function withSetup(): {
        graphStore: ReturnType<typeof createGraphStore>;
        cleanup: () => void;
    } {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-handler-search-'));
        secretsPath = join(graphsDir, 'secrets.env');
        writeFileSync(secretsPath, 'TAVILY_API_KEY=tvly-from-store\n', 'utf8');
        return {
            graphStore: createGraphStore({ dir: graphsDir }),
            cleanup: () => rmSync(graphsDir, { recursive: true, force: true }),
        };
    }

    function searchL1(): Graph {
        return {
            kind: 'l1',
            id: 'l1-search',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'h1', type: 'handler', name: 'SimpleHandler', position: { x: 100, y: 0 } },
                { id: 'out', type: 'output', position: { x: 200, y: 0 } },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/A',
                    system_prompt: 'searcher',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'search',
                    type: 'tool',
                    tool_name: 'web_search',
                    config: { provider: 'tavily' },
                    position: { x: 100, y: 160 },
                },
                {
                    id: 'sec',
                    type: 'secrets',
                    bindings: [{ name: 'TAVILY_API_KEY', source: 'env:TAVILY_API_KEY' }],
                    position: { x: 0, y: 160 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                { id: 'search->h', source: { node_id: 'search' }, target: { node_id: 'h1' } },
                { id: 'sec->search', source: { node_id: 'sec' }, target: { node_id: 'search' } },
            ],
        };
    }

    function searchScriptedClient(): { client: ModelClient; calls: CompleteRequest[] } {
        const calls: CompleteRequest[] = [];
        let i = 0;
        return {
            calls,
            client: {
                async *complete(req) {
                    calls.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
                    const turn = i++;
                    if (turn === 0) {
                        yield {
                            delta: '',
                            finish_reason: 'tool_calls',
                            tool_calls: [
                                {
                                    id: 'call-search-1',
                                    name: 'web_search',
                                    arguments: JSON.stringify({ query: 'fabritorio' }),
                                },
                            ],
                        };
                        return;
                    }
                    yield { delta: 'done', finish_reason: 'stop' };
                },
            },
        };
    }

    it('a Secrets→web_search wire lets the built tool read the wired key', async () => {
        const { graphStore, cleanup } = withSetup();
        let seenAuth: string | undefined;
        const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            seenAuth = headers.Authorization;
            return {
                ok: true,
                status: 200,
                text: async () => '',
                json: async () => ({
                    results: [
                        { title: 'Fabritorio', url: 'https://fabritorio.dev', content: 'docs' },
                    ],
                }),
            } as unknown as Response;
        }) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchStub);
        try {
            const sink = searchScriptedClient();
            const built = await buildHandlerFromL1(searchL1(), {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: () => sink.client,
                secretsStore: createSecretsStore({ path: secretsPath }),
            });
            await built.handler.run([{ role: 'user', content: 'find docs' }], {
                eventId: 'ev-search',
            });

            expect(seenAuth).toBe('Bearer tvly-from-store');

            expect(sink.calls).toHaveLength(2);
            const secondMessages = sink.calls[1]!.messages;
            const toolMsg = secondMessages.find((m) => m.role === 'tool');
            expect(toolMsg).toBeDefined();
            const toolText = typeof toolMsg!.content === 'string' ? toolMsg!.content : '';
            expect(toolText).toMatch(/# Results for "fabritorio"/);
            expect(toolText).toMatch(/\[Fabritorio\]\(https:\/\/fabritorio\.dev\)/);
            expect(toolText).not.toMatch(/no API key wired/);
        } finally {
            vi.unstubAllGlobals();
            cleanup();
        }
    });

    it('without the Secrets wire the same tool refuses (key not granted)', async () => {
        const { graphStore, cleanup } = withSetup();
        let fetched = false;
        const fetchStub = (async () => {
            fetched = true;
            return {
                ok: true,
                status: 200,
                text: async () => '',
                json: async () => ({}),
            } as unknown as Response;
        }) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchStub);
        try {
            const l1 = searchL1();
            l1.nodes = l1.nodes.filter((n) => n.id !== 'sec');
            l1.edges = l1.edges.filter((e) => e.id !== 'sec->search');

            const sink = searchScriptedClient();
            const built = await buildHandlerFromL1(l1, {
                graphStore,
                skillRegistry: createSkillRegistry([]),
                handlerRegistry: createDefaultHandlerRegistry(),
                modelClientFor: () => sink.client,
                secretsStore: createSecretsStore({ path: secretsPath }),
            });
            await built.handler.run([{ role: 'user', content: 'find docs' }], {
                eventId: 'ev-search-nokey',
            });

            const secondMessages = sink.calls[1]!.messages;
            const toolMsg = secondMessages.find((m) => m.role === 'tool');
            const toolText = typeof toolMsg!.content === 'string' ? toolMsg!.content : '';
            expect(toolText).toMatch(/no API key wired for tavily/);
            expect(fetched).toBe(false);
        } finally {
            vi.unstubAllGlobals();
            cleanup();
        }
    });
});
