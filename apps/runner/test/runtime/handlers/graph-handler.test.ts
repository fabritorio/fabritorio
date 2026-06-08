import { describe, it, expect } from 'vitest';
import type { Graph, Message, ObservabilityEvent } from '@fabritorio/types';
import {
    createGraphHandler,
    repairStoppedBuffer,
} from '../../../src/runtime/handlers/graph-handler.js';
import { buildDefaultSimpleHandlerGraph } from '../../../src/runtime/handlers/default-graph.js';
import type { CompleteChunk, CompleteRequest, ModelClient } from '../../../src/runtime/model.js';
import type { ChatMessage } from '../../../src/runtime/model.js';
import type { CheckpointBinding, ConsultResult } from '../../../src/runtime/checkpoint.js';
import type { Tool } from '../../../src/runtime/tools.js';

interface ScriptedTurn {
    text?: string[];
    tool_calls?: Array<{ id: string; name: string; arguments: string }>;
    finish_reason?: string;
}

function scriptedModel(turns: ScriptedTurn[]): {
    client: ModelClient;
    calls: CompleteRequest[];
} {
    const calls: CompleteRequest[] = [];
    let i = 0;
    const client: ModelClient = {
        async *complete(req) {
            calls.push({
                ...req,
                messages: req.messages.map((m) => ({ ...m })),
            });
            const turn = turns[i++];
            if (!turn) throw new Error('scripted model exhausted');
            for (const delta of turn.text ?? []) yield { delta };
            const tail: CompleteChunk = {
                delta: '',
                finish_reason: turn.finish_reason ?? 'stop',
                ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}),
            };
            yield tail;
        },
    };
    return { client, calls };
}

const echoTool: Tool = {
    spec: {
        name: 'echo',
        description: 'echo back args.value',
        parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
        },
    },
    handler: (args) => ({
        stdout: typeof args.value === 'string' ? args.value : '',
        stderr: '',
        exit_code: 0,
    }),
};

function defaultGraph(): Graph {
    return {
        id: 'graph-test',
        ...buildDefaultSimpleHandlerGraph(),
    };
}

describe('createGraphHandler — default ReAct shape', () => {
    it('returns the assistant text on a single text turn', async () => {
        const { client, calls } = scriptedModel([{ text: ['Hello'], finish_reason: 'stop' }]);
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: 'you are a tester',
            tools: [],
            toolNodeIds: new Map(),
        });
        const inbound: Message[] = [{ role: 'user', content: 'hi' }];
        const result = await handler.run(inbound, { eventId: 'evt-1' });
        expect(result.errored).toBe(false);
        expect(result.output.role).toBe('assistant');
        expect(result.output.content).toBe('Hello');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.messages[0]).toEqual({
            role: 'system',
            content: 'you are a tester',
        });
        expect(calls[0]!.messages[1]).toMatchObject({ role: 'user', content: 'hi' });
    });

    it('loops through tool_exec when the model issues a tool_call', async () => {
        const { client, calls } = scriptedModel([
            {
                tool_calls: [
                    { id: 'c1', name: 'echo', arguments: JSON.stringify({ value: 'pong' }) },
                ],
                finish_reason: 'tool_calls',
            },
            { text: ['done: pong'], finish_reason: 'stop' },
        ]);
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: '',
            tools: [echoTool],
            toolNodeIds: new Map([['echo', 'tool-1']]),
        });
        const result = await handler.run([{ role: 'user', content: 'loop' }], {
            eventId: 'evt-1',
        });
        expect(result.errored).toBe(false);
        expect(result.output.content).toBe('done: pong');
        expect(calls).toHaveLength(2);
        const secondMsgs = calls[1]!.messages;
        const lastTool = secondMsgs[secondMsgs.length - 1]!;
        expect(lastTool.role).toBe('tool');
        expect(lastTool.content).toBe('pong');
        expect(lastTool.tool_call_id).toBe('c1');
    });

    it('redacts secret values from the emitted tool result (canonical graph path)', async () => {
        const leakyTool: Tool = {
            spec: {
                name: 'whoami',
                description: 'echoes a secret it should not',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
            handler: () => ({ stdout: 'token=sk-test-123', stderr: '', exit_code: 0 }),
        };
        const { client } = scriptedModel([
            {
                tool_calls: [{ id: 'c1', name: 'whoami', arguments: '{}' }],
                finish_reason: 'tool_calls',
            },
            { text: ['ok'], finish_reason: 'stop' },
        ]);
        const events: ObservabilityEvent[] = [];
        const store = {
            get: () => undefined,
            has: () => false,
            values: () => ['sk-test-123'],
            rescan: () => {},
        };
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: '',
            tools: [leakyTool],
            toolNodeIds: new Map([['whoami', 'tool-w']]),
            secretsStore: store,
        });
        await handler.run([{ role: 'user', content: 'go' }], {
            eventId: 'evt-redact',
            emitObservability: (e) => events.push(e),
        });
        const result = events.find((e) => e.type === 'tool.result');
        expect(result?.type === 'tool.result' && result.stdout).toBe('token=«redacted»');
        expect(result?.type === 'tool.result' && result.stdout).not.toContain('sk-test-123');
    });

    it('respects max_iterations on infinite tool loops', async () => {
        const { client, calls } = scriptedModel(
            Array.from({ length: 20 }, () => ({
                tool_calls: [{ id: 'c', name: 'echo', arguments: JSON.stringify({ value: 'x' }) }],
                finish_reason: 'tool_calls',
            })),
        );
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: '',
            tools: [echoTool],
            toolNodeIds: new Map([['echo', 'tool-1']]),
            maxIterations: 3,
        });
        const result = await handler.run([{ role: 'user', content: 'loop' }], {
            eventId: 'evt-1',
        });
        expect(result.errored).toBe(true);
        expect(result.output.content).toMatch(/3 model calls/);
        expect(calls.length).toBe(3);
    });
});

describe('createGraphHandler — token-cadence checkpoints', () => {
    const bloatTool: Tool = {
        spec: {
            name: 'bloat',
            description: 'returns a large blob',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        handler: () => ({ stdout: 'x'.repeat(4000), stderr: '', exit_code: 0 }),
    };

    function recordingMutator(): { binding: CheckpointBinding; consults: ChatMessage[][] } {
        const consults: ChatMessage[][] = [];
        const binding: CheckpointBinding = {
            cadence: { kind: 'tokens', at_fraction: 0.5 },
            handle: {
                graphId: 'g',
                nodeId: 'cp',
                strategy: 'mutator',
                async consult(messages): Promise<ConsultResult> {
                    consults.push(messages.map((m) => ({ ...m })));
                    const system = messages.find((m) => m.role === 'system');
                    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
                    const replacement: ChatMessage[] = [];
                    if (system) replacement.push(system);
                    if (lastUser) replacement.push(lastUser);
                    return { buffer_replacement: replacement };
                },
            },
        };
        return { binding, consults };
    }

    it('fires on the rising edge once per crossing, not every turn', async () => {
        const { client } = scriptedModel([
            {
                tool_calls: [{ id: 'c1', name: 'bloat', arguments: '{}' }],
                finish_reason: 'tool_calls',
            },
            {
                tool_calls: [{ id: 'c2', name: 'echo', arguments: JSON.stringify({ value: 'k' }) }],
                finish_reason: 'tool_calls',
            },
            {
                tool_calls: [{ id: 'c3', name: 'bloat', arguments: '{}' }],
                finish_reason: 'tool_calls',
            },
            { text: ['done'], finish_reason: 'stop' },
        ]);
        const { binding, consults } = recordingMutator();
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: 'sys',
            tools: [bloatTool, echoTool],
            toolNodeIds: new Map([
                ['bloat', 'tool-b'],
                ['echo', 'tool-e'],
            ]),
            checkpoints: [binding],
            contextWindow: 1000,
            maxIterations: 10,
        });
        const result = await handler.run([{ role: 'user', content: 'go' }], {
            eventId: 'evt-tok',
        });
        expect(result.errored).toBe(false);
        expect(consults.length).toBe(2);
    });

    it('does not consult while the buffer stays under the token threshold', async () => {
        const { client } = scriptedModel([{ text: ['short answer'], finish_reason: 'stop' }]);
        const { binding, consults } = recordingMutator();
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: 'sys',
            tools: [bloatTool],
            toolNodeIds: new Map([['bloat', 'tool-b']]),
            checkpoints: [binding],
            contextWindow: 1_000_000,
            maxIterations: 10,
        });
        const result = await handler.run([{ role: 'user', content: 'hi' }], {
            eventId: 'evt-tok2',
        });
        expect(result.errored).toBe(false);
        expect(consults.length).toBe(0);
    });
});

describe('createGraphHandler — graph topology errors', () => {
    it('rejects a graph with no handler_input', () => {
        const bad: Graph = {
            id: 'bad',
            kind: 'handler',
            nodes: [{ id: 'h-out', type: 'handler_output', position: { x: 0, y: 0 } }],
            edges: [],
        };
        expect(() =>
            createGraphHandler({
                graph: bad,
                model: scriptedModel([]).client,
                modelId: 'x',
                modelNodeId: 'm',
                handlerNodeId: 'h',
                systemPrompt: '',
                tools: [],
                toolNodeIds: new Map(),
            }),
        ).toThrow(/handler_input/);
    });

    it('errors out when a primitive has no outgoing edge', async () => {
        const bad: Graph = {
            id: 'bad',
            kind: 'handler',
            nodes: [{ id: 'h-in', type: 'handler_input', position: { x: 0, y: 0 } }],
            edges: [],
        };
        const handler = createGraphHandler({
            graph: bad,
            model: scriptedModel([]).client,
            modelId: 'x',
            modelNodeId: 'm',
            handlerNodeId: 'h',
            systemPrompt: '',
            tools: [],
            toolNodeIds: new Map(),
        });
        const result = await handler.run([{ role: 'user', content: 'x' }], {
            eventId: 'evt',
        });
        expect(result.errored).toBe(true);
        expect(result.output.content).toMatch(/no outgoing edge/);
    });
});

describe('createGraphHandler — dispatch stop (signal)', () => {
    it('an already-aborted signal returns { stopped: true } without calling the model', async () => {
        const { client, calls } = scriptedModel([{ text: ['should not run'] }]);
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: 'you are a tester',
            tools: [],
            toolNodeIds: new Map(),
        });
        const controller = new AbortController();
        controller.abort();
        const events: ObservabilityEvent[] = [];
        const result = await handler.run([{ role: 'user', content: 'hi' }], {
            eventId: 'evt-stop',
            signal: controller.signal,
            emitObservability: (e) => events.push(e),
        });
        expect(result.stopped).toBe(true);
        expect(result.errored).toBe(false);
        expect(calls).toHaveLength(0);
        expect(events.some((e) => e.type === 'dispatch.stopped')).toBe(true);
    });

    it('a mid-stream abort skips the assistant push (no partial turn) and returns stopped', async () => {
        const controller = new AbortController();
        const client: ModelClient = {
            async *complete() {
                yield { delta: 'partial ' };
                controller.abort();
                yield { delta: 'should-be-dropped', finish_reason: 'stop' };
            },
        };
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: '',
            tools: [],
            toolNodeIds: new Map(),
        });
        const events: ObservabilityEvent[] = [];
        const result = await handler.run([{ role: 'user', content: 'hi' }], {
            eventId: 'evt-stop-2',
            signal: controller.signal,
            emitObservability: (e) => events.push(e),
        });
        expect(result.stopped).toBe(true);
        expect(result.errored).toBe(false);
        expect(events.some((e) => e.type === 'llm.response')).toBe(false);
        expect(events.some((e) => e.type === 'dispatch.stopped')).toBe(true);
    });

    it('a mid-tool abort stops the remaining tools and returns stopped (no further model call)', async () => {
        const controller = new AbortController();
        const ran: string[] = [];
        const aborterTool: Tool = {
            spec: {
                name: 'aborter',
                description: 'aborts the dispatch when called',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
            handler: () => {
                ran.push('aborter');
                controller.abort();
                return { stdout: 'aborted', stderr: '', exit_code: 0 };
            },
        };
        const secondTool: Tool = {
            spec: {
                name: 'second',
                description: 'must never run after a stop',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
            handler: () => {
                ran.push('second');
                return { stdout: 'second-ran', stderr: '', exit_code: 0 };
            },
        };
        const { client, calls } = scriptedModel([
            {
                tool_calls: [
                    { id: 'c1', name: 'aborter', arguments: '{}' },
                    { id: 'c2', name: 'second', arguments: '{}' },
                ],
                finish_reason: 'tool_calls',
            },
            { text: ['should not run'], finish_reason: 'stop' },
        ]);
        const events: ObservabilityEvent[] = [];
        const handler = createGraphHandler({
            graph: defaultGraph(),
            model: client,
            modelId: 'gpt-test',
            modelNodeId: 'model-1',
            handlerNodeId: 'handler-1',
            systemPrompt: '',
            tools: [aborterTool, secondTool],
            toolNodeIds: new Map([
                ['aborter', 'tool-a'],
                ['second', 'tool-s'],
            ]),
        });
        const result = await handler.run([{ role: 'user', content: 'go' }], {
            eventId: 'evt-stop-tool',
            signal: controller.signal,
            emitObservability: (e) => events.push(e),
        });
        expect(result.stopped).toBe(true);
        expect(result.errored).toBe(false);
        expect(ran).toEqual(['aborter']);
        expect(calls).toHaveLength(1);
        const called = events.filter((e) => e.type === 'tool.called');
        expect(called).toHaveLength(1);
        expect(events.some((e) => e.type === 'dispatch.stopped')).toBe(true);
    });
});

describe('repairStoppedBuffer — mid-tool buffer well-formedness', () => {
    it('backfills [cancelled by user] for every preempted tool_call', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'c1', name: 'a', arguments: '{}' },
                    { id: 'c2', name: 'b', arguments: '{}' },
                    { id: 'c3', name: 'c', arguments: '{}' },
                ],
            },
            { role: 'tool', content: 'c1 ran', tool_call_id: 'c1' },
        ];
        repairStoppedBuffer(messages);
        const assistant = messages.find((m) => m.role === 'assistant')!;
        const resultIds = new Set(
            messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
        );
        for (const tc of assistant.tool_calls!) {
            expect(resultIds.has(tc.id)).toBe(true);
        }
        const byId = new Map(
            messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]),
        );
        expect(byId.get('c1')).toBe('c1 ran');
        expect(byId.get('c2')).toBe('[cancelled by user]');
        expect(byId.get('c3')).toBe('[cancelled by user]');
    });

    it('is a no-op when the last assistant message has no tool_calls (mid-model abort)', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'a partial thought' },
        ];
        const before = messages.length;
        repairStoppedBuffer(messages);
        expect(messages).toHaveLength(before);
    });

    it('is a no-op when every tool_call is already answered', () => {
        const messages: ChatMessage[] = [
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', name: 'a', arguments: '{}' }],
            },
            { role: 'tool', content: 'done', tool_call_id: 'c1' },
        ];
        const before = messages.length;
        repairStoppedBuffer(messages);
        expect(messages).toHaveLength(before);
    });
});
