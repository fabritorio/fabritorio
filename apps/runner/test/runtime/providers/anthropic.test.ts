import { describe, expect, it } from 'vitest';
import type {
    MessageCreateParamsStreaming,
    RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import {
    ModelInvocationError,
    type ChatMessage,
    type CompleteChunk,
    type CompleteRequest,
} from '../../../src/runtime/model.js';
import {
    createAnthropicClient,
    type AnthropicLike,
} from '../../../src/runtime/providers/anthropic.js';

type FakeEvent = Partial<RawMessageStreamEvent>;

interface ScriptedClient {
    client: AnthropicLike;
    calls: MessageCreateParamsStreaming[];
}

function scriptedClient(events: FakeEvent[] | (() => AsyncIterable<FakeEvent>)): ScriptedClient {
    const calls: ScriptedClient['calls'] = [];
    const client: AnthropicLike = {
        messages: {
            create: (params) => {
                calls.push(params);
                if (typeof events === 'function') {
                    return Promise.resolve(events() as AsyncIterable<RawMessageStreamEvent>);
                }
                const iter = (async function* () {
                    for (const e of events) yield e as RawMessageStreamEvent;
                })();
                return Promise.resolve(iter);
            },
        },
    };
    return { client, calls };
}

function makeClientWith(events: FakeEvent[] | (() => AsyncIterable<FakeEvent>)) {
    const scripted = scriptedClient(events);
    const modelClient = createAnthropicClient({
        apiKey: 'fake',
        clientFactory: () => scripted.client,
    });
    return { modelClient, calls: scripted.calls };
}

function baseReq(messages?: ChatMessage[]): CompleteRequest {
    return {
        model: 'claude-opus-4-8',
        messages: messages ?? [{ role: 'user', content: 'hi' }],
    };
}

async function drain(iter: AsyncIterable<CompleteChunk>): Promise<CompleteChunk[]> {
    const out: CompleteChunk[] = [];
    for await (const c of iter) out.push(c);
    return out;
}

const textDelta = (index: number, text: string): FakeEvent => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
});
const thinkingDelta = (index: number, thinking: string): FakeEvent => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
});
const signatureDelta = (index: number, signature: string): FakeEvent => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'signature_delta', signature },
});
const inputJsonDelta = (index: number, partial_json: string): FakeEvent => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json },
});
const thinkingStart = (index: number): FakeEvent =>
    ({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
    }) as unknown as FakeEvent;
const toolStart = (index: number, id: string, name: string): FakeEvent =>
    ({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name, input: {} },
    }) as unknown as FakeEvent;
const blockStop = (index: number): FakeEvent => ({ type: 'content_block_stop', index });
const messageStop = (stop_reason: string): FakeEvent =>
    ({
        type: 'message_delta',
        delta: { stop_reason, stop_sequence: null },
    }) as unknown as FakeEvent;

describe('createAnthropicClient — streaming', () => {
    it('plain text: 3 deltas + final stop', async () => {
        const { modelClient } = makeClientWith([
            textDelta(0, 'hel'),
            textDelta(0, 'lo '),
            textDelta(0, 'world'),
            messageStop('end_turn'),
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        expect(chunks).toEqual([
            { delta: 'hel' },
            { delta: 'lo ' },
            { delta: 'world' },
            { delta: '', finish_reason: 'stop' },
        ]);
    });

    it('thinking deltas surface on reasoning; text on delta', async () => {
        const { modelClient } = makeClientWith([
            thinkingStart(0),
            thinkingDelta(0, 'plan: be brief'),
            blockStop(0),
            textDelta(1, 'Hi.'),
            messageStop('end_turn'),
        ]);

        const chunks = await drain(modelClient.complete({ ...baseReq(), reasoning: true }));
        expect(chunks).toEqual([
            { delta: '', reasoning: 'plan: be brief' },
            { delta: 'Hi.' },
            { delta: '', finish_reason: 'stop' },
        ]);
    });

    it('tool-call accumulation → one final chunk with id/name/arguments', async () => {
        const { modelClient } = makeClientWith([
            toolStart(0, 'toolu_1', 'lookup'),
            inputJsonDelta(0, '{"q":'),
            inputJsonDelta(0, '"tea"}'),
            blockStop(0),
            messageStop('tool_use'),
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        expect(chunks.at(-1)).toEqual({
            delta: '',
            tool_calls: [{ id: 'toolu_1', name: 'lookup', arguments: '{"q":"tea"}' }],
            finish_reason: 'tool_calls',
        });
    });

    it('multiple tool calls in one turn → all surface in arrival order', async () => {
        const { modelClient } = makeClientWith([
            toolStart(0, 'a', 'fetch'),
            inputJsonDelta(0, '{"url":"/a"}'),
            blockStop(0),
            toolStart(1, 'b', 'fetch'),
            inputJsonDelta(1, '{"url":"/b"}'),
            blockStop(1),
            messageStop('tool_use'),
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        const final = chunks.at(-1)!;
        expect(final.tool_calls).toHaveLength(2);
        expect(final.tool_calls?.[0]).toEqual({
            id: 'a',
            name: 'fetch',
            arguments: '{"url":"/a"}',
        });
        expect(final.tool_calls?.[1]).toEqual({
            id: 'b',
            name: 'fetch',
            arguments: '{"url":"/b"}',
        });
    });

    it('thinking-signature round trip: tool-use turn captures signature into provider_metadata.anthropic', async () => {
        const { modelClient } = makeClientWith([
            thinkingStart(0),
            thinkingDelta(0, 'I should look it up.'),
            signatureDelta(0, 'sig-'),
            signatureDelta(0, 'abc'),
            blockStop(0),
            toolStart(1, 'toolu_42', 'lookup'),
            inputJsonDelta(1, '{"q":"tea"}'),
            blockStop(1),
            messageStop('tool_use'),
        ]);

        const chunks = await drain(modelClient.complete({ ...baseReq(), reasoning: true }));
        const final = chunks.at(-1)!;
        expect(final.tool_calls).toHaveLength(1);
        expect(final.tool_calls?.[0]?.provider_metadata).toEqual({
            anthropic: {
                thinking: [{ thinking: 'I should look it up.', signature: 'sig-abc' }],
            },
        });
    });

    it('round-trip replay: assistant tool_calls with stashed thinking → thinking blocks precede tool_use', async () => {
        const { modelClient, calls } = makeClientWith([
            textDelta(0, 'ok'),
            messageStop('end_turn'),
        ]);

        const messages: ChatMessage[] = [
            { role: 'system', content: 'you are terse' },
            { role: 'user', content: 'lookup tea' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'toolu_42',
                        name: 'lookup',
                        arguments: JSON.stringify({ q: 'tea' }),
                        provider_metadata: {
                            anthropic: {
                                thinking: [{ thinking: 'look it up', signature: 'sig-xyz' }],
                            },
                        },
                    },
                ],
            },
            { role: 'tool', content: 'green tea result', tool_call_id: 'toolu_42' },
        ];

        await drain(modelClient.complete(baseReq(messages)));

        expect(calls).toHaveLength(1);
        const sent = calls[0]!;
        expect(Array.isArray(sent.system)).toBe(true);
        expect((sent.system as { text: string }[])[0]?.text).toBe('you are terse');
        const msgs = sent.messages;
        expect(msgs).toHaveLength(3);
        expect(msgs[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'lookup tea' }] });
        const assistant = msgs[1]!;
        expect(assistant.role).toBe('assistant');
        const content = assistant.content as Array<Record<string, unknown>>;
        expect(content[0]).toEqual({
            type: 'thinking',
            thinking: 'look it up',
            signature: 'sig-xyz',
        });
        expect(content.at(-1)).toEqual({
            type: 'tool_use',
            id: 'toolu_42',
            name: 'lookup',
            input: { q: 'tea' },
        });
        const toolMsg = msgs[2]!;
        expect(toolMsg.role).toBe('user');
        expect((toolMsg.content as Array<Record<string, unknown>>)[0]).toEqual({
            type: 'tool_result',
            tool_use_id: 'toolu_42',
            content: 'green tea result',
        });
    });

    it('system collapse: multiple system messages join with \\n\\n', async () => {
        const { modelClient, calls } = makeClientWith([messageStop('end_turn')]);
        await drain(
            modelClient.complete(
                baseReq([
                    { role: 'system', content: 'one' },
                    { role: 'system', content: 'two' },
                    { role: 'user', content: 'hi' },
                ]),
            ),
        );
        expect((calls[0]!.system as { text: string }[])[0]?.text).toBe('one\n\ntwo');
    });

    it('stop_reason mapping', async () => {
        const cases: Array<[string, string]> = [
            ['end_turn', 'stop'],
            ['stop_sequence', 'stop'],
            ['max_tokens', 'length'],
            ['tool_use', 'tool_calls'],
            ['refusal', 'content_filter'],
        ];
        for (const [raw, mapped] of cases) {
            const { modelClient } = makeClientWith([messageStop(raw)]);
            const chunks = await drain(modelClient.complete(baseReq()));
            expect(chunks.at(-1)?.finish_reason).toBe(mapped);
        }
    });

    it('max_tokens default (4096) applied when req.max_tokens is undefined', async () => {
        const { modelClient, calls } = makeClientWith([messageStop('end_turn')]);
        await drain(modelClient.complete(baseReq()));
        expect(calls[0]!.max_tokens).toBe(4096);

        const { modelClient: mc2, calls: calls2 } = makeClientWith([messageStop('end_turn')]);
        await drain(mc2.complete({ ...baseReq(), max_tokens: 100 }));
        expect(calls2[0]!.max_tokens).toBe(100);
    });

    it('thinking enabled omits temperature; sends thinking config', async () => {
        const { modelClient, calls } = makeClientWith([messageStop('end_turn')]);
        await drain(modelClient.complete({ ...baseReq(), reasoning: true, temperature: 0.7 }));
        const sent = calls[0]!;
        expect(sent.temperature).toBeUndefined();
        expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });

    it('thinking disabled forwards temperature normally', async () => {
        const { modelClient, calls } = makeClientWith([messageStop('end_turn')]);
        await drain(modelClient.complete({ ...baseReq(), temperature: 0.3 }));
        expect(calls[0]!.temperature).toBe(0.3);
        expect(calls[0]!.thinking).toBeUndefined();
    });

    it('prompt caching: cache_control on system block and last tool', async () => {
        const req: CompleteRequest = {
            ...baseReq([
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'hi' },
            ]),
            tools: [
                { name: 't1', description: 'd1', parameters: { type: 'object' } },
                { name: 't2', description: 'd2', parameters: { type: 'object' } },
            ],
        };
        const { modelClient, calls } = makeClientWith([messageStop('end_turn')]);
        await drain(modelClient.complete(req));
        const sent = calls[0]!;
        expect((sent.system as { cache_control?: unknown }[])[0]?.cache_control).toEqual({
            type: 'ephemeral',
        });
        const tools = sent.tools!;
        expect(tools[0]?.cache_control).toBeUndefined();
        expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('error path: SDK throws on stream open → ModelInvocationError', async () => {
        const failing: AnthropicLike = {
            messages: { create: () => Promise.reject(new Error('anthropic boom: bad key')) },
        };
        const modelClient = createAnthropicClient({
            apiKey: 'fake',
            clientFactory: () => failing,
        });
        await expect(drain(modelClient.complete(baseReq()))).rejects.toBeInstanceOf(
            ModelInvocationError,
        );
        try {
            await drain(modelClient.complete(baseReq()));
        } catch (e) {
            expect((e as Error).message).toContain('anthropic boom: bad key');
        }
    });

    it('error path: mid-stream throw → ModelInvocationError', async () => {
        const { modelClient } = makeClientWith(async function* () {
            yield textDelta(0, 'partial') as RawMessageStreamEvent;
            throw new Error('stream blew up');
        });
        await expect(drain(modelClient.complete(baseReq()))).rejects.toThrow(ModelInvocationError);
    });
});
