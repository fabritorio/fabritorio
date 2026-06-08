import { describe, expect, it } from 'vitest';
import type { Content, GenerateContentResponse } from '@google/genai';
import {
    ModelInvocationError,
    type ChatMessage,
    type CompleteChunk,
    type CompleteRequest,
} from '../../../src/runtime/model.js';
import { createGeminiClient, type GoogleGenAILike } from '../../../src/runtime/providers/gemini.js';

type FakeChunk = Partial<GenerateContentResponse>;

interface ScriptedClient {
    client: GoogleGenAILike;
    calls: Array<Parameters<GoogleGenAILike['models']['generateContentStream']>[0]>;
}

function scriptedClient(chunks: FakeChunk[] | (() => AsyncIterable<FakeChunk>)): ScriptedClient {
    const calls: ScriptedClient['calls'] = [];
    const client: GoogleGenAILike = {
        models: {
            generateContentStream: (params) => {
                calls.push(params);
                if (typeof chunks === 'function') {
                    return Promise.resolve(chunks() as AsyncIterable<GenerateContentResponse>);
                }
                const iter = (async function* () {
                    for (const c of chunks) yield c as GenerateContentResponse;
                })();
                return Promise.resolve(iter);
            },
        },
    };
    return { client, calls };
}

function makeClientWith(chunks: FakeChunk[] | (() => AsyncIterable<FakeChunk>)) {
    const scripted = scriptedClient(chunks);
    const modelClient = createGeminiClient({
        apiKey: 'fake',
        clientFactory: () => scripted.client,
    });
    return { modelClient, calls: scripted.calls };
}

function baseReq(messages?: ChatMessage[]): CompleteRequest {
    return {
        model: 'gemini-2.5-flash',
        messages: messages ?? [{ role: 'user', content: 'hi' }],
    };
}

async function drain(iter: AsyncIterable<CompleteChunk>): Promise<CompleteChunk[]> {
    const out: CompleteChunk[] = [];
    for await (const c of iter) out.push(c);
    return out;
}

describe('createGeminiClient — streaming', () => {
    it('plain text: 3 chunks → 3 deltas + final stop', async () => {
        const { modelClient } = makeClientWith([
            { candidates: [{ content: { role: 'model', parts: [{ text: 'hel' }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: 'lo ' }] } }] },
            {
                candidates: [
                    {
                        content: { role: 'model', parts: [{ text: 'world' }] },
                        finishReason: 'STOP' as never,
                    },
                ],
            },
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        expect(chunks).toEqual([
            { delta: 'hel' },
            { delta: 'lo ' },
            { delta: 'world' },
            { delta: '', finish_reason: 'stop' },
        ]);
    });

    it('thinking + text interleaved → reasoning + delta in arrival order', async () => {
        const { modelClient } = makeClientWith([
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [{ text: 'plan: respond briefly', thought: true }],
                        },
                    },
                ],
            },
            { candidates: [{ content: { role: 'model', parts: [{ text: 'Hi.' }] } }] },
            {
                candidates: [
                    {
                        content: { role: 'model', parts: [{ text: ' Done.' }] },
                        finishReason: 'STOP' as never,
                    },
                ],
            },
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        expect(chunks).toEqual([
            { delta: '', reasoning: 'plan: respond briefly' },
            { delta: 'Hi.' },
            { delta: ' Done.' },
            { delta: '', finish_reason: 'stop' },
        ]);
    });

    it('tool call with thoughtSignature → provider_metadata.google.thought_signature set', async () => {
        const { modelClient } = makeClientWith([
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: {
                                        id: 'call_1',
                                        name: 'lookup',
                                        args: { q: 'tea' },
                                    },
                                    thoughtSignature: 'sig-abc',
                                },
                            ],
                        },
                        finishReason: 'STOP' as never,
                    },
                ],
            },
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        expect(chunks.at(-1)).toEqual({
            delta: '',
            tool_calls: [
                {
                    id: 'call_1',
                    name: 'lookup',
                    arguments: JSON.stringify({ q: 'tea' }),
                    provider_metadata: { google: { thought_signature: 'sig-abc' } },
                },
            ],
            finish_reason: 'stop',
        });
    });

    it('parallel calls split across chunks → all accumulate; signed lead survives', async () => {
        const { modelClient } = makeClientWith([
            {
                candidates: [
                    { content: { role: 'model', parts: [{ text: 'plan', thought: true }] } },
                ],
            },
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: {
                                        id: 'c1',
                                        name: 'echo',
                                        args: { message: '1' },
                                    },
                                    thoughtSignature: 'sig-1',
                                },
                            ],
                        },
                    },
                ],
            },
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: {
                                        id: 'c2',
                                        name: 'echo',
                                        args: { message: '2' },
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: {
                                        id: 'c3',
                                        name: 'echo',
                                        args: { message: '3' },
                                    },
                                },
                            ],
                        },
                        finishReason: 'STOP' as never,
                    },
                ],
            },
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        const final = chunks.at(-1)!;
        expect(final.finish_reason).toBe('stop');
        expect(final.tool_calls).toHaveLength(3);
        expect(final.tool_calls?.map((tc) => tc.id)).toEqual(['c1', 'c2', 'c3']);
        expect(final.tool_calls?.[0]?.provider_metadata).toEqual({
            google: { thought_signature: 'sig-1' },
        });
        expect(final.tool_calls?.[1]?.provider_metadata).toBeUndefined();
        expect(final.tool_calls?.[2]?.provider_metadata).toBeUndefined();
    });

    it('multiple tool calls in one turn → all surface in arrival order', async () => {
        const { modelClient } = makeClientWith([
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: {
                                        id: 'a',
                                        name: 'fetch',
                                        args: { url: '/api/a' },
                                    },
                                    thoughtSignature: 'sig-a',
                                },
                                {
                                    functionCall: {
                                        id: 'b',
                                        name: 'fetch',
                                        args: { url: '/api/b' },
                                    },
                                },
                            ],
                        },
                        finishReason: 'STOP' as never,
                    },
                ],
            },
        ]);

        const chunks = await drain(modelClient.complete(baseReq()));
        const toolChunk = chunks.find((c) => c.tool_calls);
        expect(toolChunk?.tool_calls).toHaveLength(2);
        expect(toolChunk?.tool_calls?.[0]).toMatchObject({
            id: 'a',
            name: 'fetch',
            arguments: JSON.stringify({ url: '/api/a' }),
            provider_metadata: { google: { thought_signature: 'sig-a' } },
        });
        expect(toolChunk?.tool_calls?.[1]).toMatchObject({
            id: 'b',
            name: 'fetch',
            arguments: JSON.stringify({ url: '/api/b' }),
        });
        expect(toolChunk?.tool_calls?.[1]?.provider_metadata).toBeUndefined();
    });

    it('tool-result round trip: assistant tool_calls → tool msg maps to model/functionCall + user/functionResponse', async () => {
        const { modelClient, calls } = makeClientWith([
            {
                candidates: [
                    {
                        content: { role: 'model', parts: [{ text: 'ok' }] },
                        finishReason: 'STOP' as never,
                    },
                ],
            },
        ]);

        const messages: ChatMessage[] = [
            { role: 'system', content: 'you are terse' },
            { role: 'user', content: 'lookup tea' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'call_42',
                        name: 'lookup',
                        arguments: JSON.stringify({ q: 'tea' }),
                        provider_metadata: { google: { thought_signature: 'sig-xyz' } },
                    },
                ],
            },
            { role: 'tool', content: 'green tea result', tool_call_id: 'call_42' },
        ];

        await drain(modelClient.complete(baseReq(messages)));

        expect(calls).toHaveLength(1);
        const sent = calls[0]!;
        expect(
            (sent.config as { systemInstruction?: { parts: { text: string }[] } } | undefined)
                ?.systemInstruction,
        ).toEqual({
            parts: [{ text: 'you are terse' }],
        });
        const contents = sent.contents as Content[];
        expect(contents.find((c) => c.role === 'system')).toBeUndefined();
        expect(contents).toHaveLength(3);
        expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'lookup tea' }] });
        expect(contents[1]?.role).toBe('model');
        const modelPart = contents[1]?.parts?.[0];
        expect(modelPart?.functionCall).toEqual({ name: 'lookup', args: { q: 'tea' } });
        expect(modelPart?.thoughtSignature).toBe('sig-xyz');
        expect(contents[2]?.role).toBe('user');
        expect(contents[2]?.parts?.[0]?.functionResponse).toEqual({
            name: 'lookup',
            response: { content: 'green tea result' },
        });
    });

    it('reasoning toggle drives includeThoughts but never disables thinking (no thinkingBudget)', async () => {
        const scripted = () => [
            {
                candidates: [
                    {
                        content: { role: 'model', parts: [{ text: 'hi' }] },
                        finishReason: 'STOP' as never,
                    },
                ],
            },
        ];

        {
            const { modelClient, calls } = makeClientWith(scripted());
            await drain(modelClient.complete(baseReq()));
            const cfg = calls[0]?.config as {
                thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number };
            };
            expect(cfg.thinkingConfig?.includeThoughts).toBe(false);
            expect(cfg.thinkingConfig?.thinkingBudget).toBeUndefined();
        }

        {
            const { modelClient, calls } = makeClientWith(scripted());
            await drain(modelClient.complete({ ...baseReq(), reasoning: true }));
            const cfg = calls[0]?.config as {
                thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number };
            };
            expect(cfg.thinkingConfig?.includeThoughts).toBe(true);
            expect(cfg.thinkingConfig?.thinkingBudget).toBeUndefined();
        }
    });

    it('error path: SDK throws on stream open → raises ModelInvocationError', async () => {
        const failingClient: GoogleGenAILike = {
            models: {
                generateContentStream: () => Promise.reject(new Error('gemini boom: bad key')),
            },
        };
        const modelClient = createGeminiClient({
            apiKey: 'fake',
            clientFactory: () => failingClient,
        });

        await expect(drain(modelClient.complete(baseReq()))).rejects.toBeInstanceOf(
            ModelInvocationError,
        );
        try {
            await drain(modelClient.complete(baseReq()));
        } catch (e) {
            expect((e as Error).message).toContain('gemini boom: bad key');
        }
    });

    it('error path: mid-stream throw → raises ModelInvocationError', async () => {
        const { modelClient } = makeClientWith(async function* () {
            yield {
                candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }],
            } as GenerateContentResponse;
            throw new Error('stream blew up');
        });
        await expect(drain(modelClient.complete(baseReq()))).rejects.toThrow(ModelInvocationError);
    });
});
