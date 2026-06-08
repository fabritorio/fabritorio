import OpenAI from 'openai';
import {
    ModelInvocationError,
    extractReasoningDelta,
    finalizeToolCalls,
    mergeToolCallDeltas,
    type ChatMessage,
    type ModelClient,
    type ToolCallAccumulator,
} from '../model.js';
import type { ToolSpec } from '../tools.js';

export interface OpenAIClientOptions {
    apiKey: string;
    baseUrl?: string;
    chatTemplateThinking?: boolean;
}

function toOpenAIMessages(
    messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
        if (m.role === 'tool') {
            return {
                role: 'tool',
                content: m.content,
                tool_call_id: m.tool_call_id ?? '',
            };
        }
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            return {
                role: 'assistant',
                content: m.content ?? '',
                tool_calls: m.tool_calls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: tc.arguments && tc.arguments.length > 0 ? tc.arguments : '{}',
                    },
                })),
            };
        }
        if (m.role === 'assistant') {
            return { role: 'assistant', content: m.content };
        }
        if (m.role === 'system') {
            return { role: 'system', content: m.content };
        }
        return { role: 'user', content: m.content };
    });
}

function toOpenAITools(
    tools: ToolSpec[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters as Record<string, unknown>,
        },
    }));
}

export function createOpenAIClient(opts: OpenAIClientOptions): ModelClient {
    const client = new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
    });

    return {
        async *complete(req) {
            const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
                model: req.model,
                messages: toOpenAIMessages(req.messages),
                tools: toOpenAITools(req.tools),
                temperature: req.temperature,
                max_tokens: req.max_tokens,
                stream: true,
            };
            if (opts.chatTemplateThinking && req.reasoning !== undefined) {
                (body as unknown as Record<string, unknown>).chat_template_kwargs = {
                    enable_thinking: req.reasoning,
                };
            }
            let stream;
            try {
                stream = req.signal
                    ? await client.chat.completions.create(body, { signal: req.signal })
                    : await client.chat.completions.create(body);
            } catch (err) {
                throw new ModelInvocationError(
                    err instanceof Error ? err.message : 'model call failed',
                    err,
                );
            }

            const toolCallAccs = new Map<number, ToolCallAccumulator>();
            let lastFinishReason: string | undefined;

            try {
                for await (const part of stream) {
                    const choice = part.choices[0];
                    if (!choice) continue;
                    const delta = choice.delta?.content ?? '';
                    const reasoning = extractReasoningDelta(choice.delta);
                    const toolDeltas = choice.delta?.tool_calls;
                    if (toolDeltas && toolDeltas.length > 0) {
                        mergeToolCallDeltas(toolCallAccs, toolDeltas);
                    }
                    const finish_reason = choice.finish_reason ?? undefined;
                    if (finish_reason) lastFinishReason = finish_reason;
                    if (reasoning) {
                        yield { delta: '', reasoning };
                    }
                    if (delta) {
                        yield { delta };
                    }
                }
            } catch (err) {
                throw new ModelInvocationError(
                    err instanceof Error ? err.message : 'stream failed',
                    err,
                );
            }

            const tool_calls = finalizeToolCalls(toolCallAccs);
            yield {
                delta: '',
                finish_reason: lastFinishReason ?? 'stop',
                ...(tool_calls.length > 0 ? { tool_calls } : {}),
            };
        },
    };
}
