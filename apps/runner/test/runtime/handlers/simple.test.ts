import { describe, it, expect } from 'vitest';
import type { ObservabilityEvent } from '@fabritorio/types';
import { buildSystemPrompt, runSimpleHandler } from '../../../src/runtime/handlers/simple.js';
import type { CompleteChunk, CompleteRequest, ModelClient } from '../../../src/runtime/model.js';
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
            calls.push(req);
            const turn = turns[i++];
            if (!turn) {
                throw new Error('scripted model exhausted');
            }
            for (const delta of turn.text ?? []) {
                yield { delta };
            }
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
        description: 'echo args.value back',
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

describe('buildSystemPrompt', () => {
    it('concatenates model prompt and skill catalog', () => {
        const prompt = buildSystemPrompt({
            modelSystemPrompt: 'You are helpful.',
            skills: [
                { name: 'fixer', description: 'fixes things' },
                { name: 'tester', description: 'writes tests' },
            ],
        });
        expect(prompt).toContain('You are helpful.');
        expect(prompt).toContain('Available skills');
        expect(prompt).toContain('- fixer: fixes things');
        expect(prompt).toContain('- tester: writes tests');
    });

    it('omits skill block when no skills wired', () => {
        expect(buildSystemPrompt({ modelSystemPrompt: 'be terse', skills: [] })).toBe('be terse');
    });

    it('returns empty string when no inputs', () => {
        expect(buildSystemPrompt({ skills: [] })).toBe('');
    });
});

describe('runSimpleHandler', () => {
    it('returns the assistant text on a single-turn answer', async () => {
        const { client, calls } = scriptedModel([
            { text: ['hello', ' world'], finish_reason: 'stop' },
        ]);
        const result = await runSimpleHandler([{ role: 'user', content: 'hi' }], {
            model: client,
            modelId: 'fake/gpt',
            modelNodeId: 'model-1',
            handlerNodeId: 'h-1',
            systemPrompt: 'be brief',
            tools: [],
            toolNodeIds: new Map(),
            eventId: 'ev-1',
        });
        expect(result.errored).toBe(false);
        expect(result.output).toEqual({
            role: 'assistant',
            content: 'hello world',
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.messages[0]).toEqual({ role: 'system', content: 'be brief' });
        expect(calls[0]!.messages[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('routes tool_calls back to the wired Tool and loops', async () => {
        const { client, calls } = scriptedModel([
            {
                tool_calls: [
                    {
                        id: 'call-1',
                        name: 'echo',
                        arguments: JSON.stringify({ value: 'ping' }),
                    },
                ],
                finish_reason: 'tool_calls',
            },
            { text: ['got: ping'], finish_reason: 'stop' },
        ]);
        const result = await runSimpleHandler([{ role: 'user', content: 'echo ping' }], {
            model: client,
            modelId: 'fake/gpt',
            modelNodeId: 'model-1',
            handlerNodeId: 'h-1',
            systemPrompt: '',
            tools: [echoTool],
            toolNodeIds: new Map([['echo', 'tool-echo']]),
            eventId: 'ev-2',
        });
        expect(result.output).toEqual({ role: 'assistant', content: 'got: ping' });
        expect(calls).toHaveLength(2);
        const second = calls[1]!.messages;
        expect(second.at(-2)).toMatchObject({
            role: 'assistant',
            tool_calls: [{ id: 'call-1', name: 'echo' }],
        });
        expect(second.at(-1)).toEqual({
            role: 'tool',
            content: 'ping',
            tool_call_id: 'call-1',
        });
    });

    it('emits llm.* and tool.* observability events keyed by dispatch eventId', async () => {
        const { client } = scriptedModel([
            {
                tool_calls: [
                    {
                        id: 'c1',
                        name: 'echo',
                        arguments: JSON.stringify({ value: 'hi' }),
                    },
                ],
                finish_reason: 'tool_calls',
            },
            { text: ['done'], finish_reason: 'stop' },
        ]);
        const events: ObservabilityEvent[] = [];
        await runSimpleHandler([{ role: 'user', content: 'go' }], {
            model: client,
            modelId: 'fake/gpt',
            modelNodeId: 'm1',
            handlerNodeId: 'h1',
            systemPrompt: '',
            tools: [echoTool],
            toolNodeIds: new Map([['echo', 'tool-echo']]),
            eventId: 'root-evt',
            emitObservability: (e) => events.push(e),
        });
        const types = events.map((e) => e.type);
        expect(types).toContain('llm.request');
        expect(types).toContain('llm.response');
        expect(types).toContain('tool.called');
        expect(types).toContain('tool.result');
        expect(events.every((e) => e.eventId === 'root-evt')).toBe(true);
        const toolCalled = events.find((e) => e.type === 'tool.called');
        expect(toolCalled?.node_id).toBe('tool-echo');
    });

    it('returns an error result after maxIterations of pure tool turns', async () => {
        const { client } = scriptedModel([
            {
                tool_calls: [
                    {
                        id: 'c1',
                        name: 'echo',
                        arguments: JSON.stringify({ value: 'x' }),
                    },
                ],
                finish_reason: 'tool_calls',
            },
            {
                tool_calls: [
                    {
                        id: 'c2',
                        name: 'echo',
                        arguments: JSON.stringify({ value: 'y' }),
                    },
                ],
                finish_reason: 'tool_calls',
            },
        ]);
        const result = await runSimpleHandler([{ role: 'user', content: 'loop' }], {
            model: client,
            modelId: 'fake/gpt',
            modelNodeId: 'm1',
            handlerNodeId: 'h1',
            systemPrompt: '',
            tools: [echoTool],
            toolNodeIds: new Map([['echo', 'tool-echo']]),
            maxIterations: 2,
            eventId: 'ev-loop',
        });
        expect(result.errored).toBe(true);
        expect(result.output.content).toMatch(/iterations/i);
    });

    it('redacts secret values from the emitted tool result when a store is present', async () => {
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
        await runSimpleHandler([{ role: 'user', content: 'go' }], {
            model: client,
            modelId: 'fake/gpt',
            modelNodeId: 'm1',
            handlerNodeId: 'h1',
            systemPrompt: '',
            tools: [leakyTool],
            toolNodeIds: new Map([['whoami', 'tool-w']]),
            eventId: 'ev-redact',
            emitObservability: (e) => events.push(e),
            secretsStore: store,
        });
        const result = events.find((e) => e.type === 'tool.result');
        expect(result?.type === 'tool.result' && result.stdout).toBe('token=«redacted»');
        expect(result?.type === 'tool.result' && result.stdout).not.toContain('sk-test-123');
    });

    it('leaves tool result untouched when no store is wired (no-secrets path)', async () => {
        const leakyTool: Tool = {
            spec: {
                name: 'whoami',
                description: 'echoes a value',
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
        await runSimpleHandler([{ role: 'user', content: 'go' }], {
            model: client,
            modelId: 'fake/gpt',
            modelNodeId: 'm1',
            handlerNodeId: 'h1',
            systemPrompt: '',
            tools: [leakyTool],
            toolNodeIds: new Map([['whoami', 'tool-w']]),
            eventId: 'ev-no-store',
            emitObservability: (e) => events.push(e),
        });
        const result = events.find((e) => e.type === 'tool.result');
        expect(result?.type === 'tool.result' && result.stdout).toBe('token=sk-test-123');
    });

    it("surfaces tool errors as the tool message's content without aborting", async () => {
        const exploding: Tool = {
            spec: {
                name: 'boom',
                description: 'always fails',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
            handler: () => ({ stdout: '', stderr: 'kaboom', exit_code: 2 }),
        };
        const { client } = scriptedModel([
            {
                tool_calls: [{ id: 'c1', name: 'boom', arguments: '{}' }],
                finish_reason: 'tool_calls',
            },
            { text: ['recovered'], finish_reason: 'stop' },
        ]);
        const result = await runSimpleHandler([{ role: 'user', content: 'try' }], {
            model: client,
            modelId: 'fake/gpt',
            modelNodeId: 'm1',
            handlerNodeId: 'h1',
            systemPrompt: '',
            tools: [exploding],
            toolNodeIds: new Map(),
            eventId: 'ev-3',
        });
        expect(result.errored).toBe(false);
        expect(result.output).toEqual({ role: 'assistant', content: 'recovered' });
    });
});
