import Anthropic from '@anthropic-ai/sdk';
import type {
    MessageCreateParamsStreaming,
    MessageParam,
    RawMessageStreamEvent,
    TextBlockParam,
    ThinkingBlockParam,
    Tool,
    ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import {
    ModelInvocationError,
    type ChatMessage,
    type CompleteRequest,
    type ModelClient,
    type ToolCall,
} from '../model.js';

export interface AnthropicClientOptions {
    apiKey: string;
    baseUrl?: string;
    clientFactory?: (opts: { apiKey: string; baseUrl?: string }) => AnthropicLike;
}

export interface AnthropicLike {
    messages: {
        create: (
            params: MessageCreateParamsStreaming,
            options?: { signal?: AbortSignal },
        ) => Promise<AsyncIterable<RawMessageStreamEvent>>;
    };
}

interface AnthropicThinking {
    thinking: string;
    signature: string;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_BUDGET = 2048;

function readAnthropicThinking(meta: ToolCall['provider_metadata']): AnthropicThinking[] {
    if (!meta || typeof meta !== 'object') return [];
    const anthropic = (meta as { anthropic?: unknown }).anthropic;
    if (!anthropic || typeof anthropic !== 'object') return [];
    const thinking = (anthropic as { thinking?: unknown }).thinking;
    if (!Array.isArray(thinking)) return [];
    return thinking.filter(
        (t): t is AnthropicThinking =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as AnthropicThinking).thinking === 'string' &&
            typeof (t as AnthropicThinking).signature === 'string',
    );
}

function safeJsonParse(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function toAnthropicRequest(messages: ChatMessage[]): {
    system?: string;
    messages: MessageParam[];
} {
    const systemTexts: string[] = [];
    const out: MessageParam[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            if (m.content) systemTexts.push(m.content);
            continue;
        }
        if (m.role === 'user') {
            out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
            continue;
        }
        if (m.role === 'tool') {
            out.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: m.tool_call_id ?? '',
                        content: m.content,
                    },
                ],
            });
            continue;
        }
        const content: Array<TextBlockParam | ThinkingBlockParam | ToolUseBlockParam> = [];
        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                for (const t of readAnthropicThinking(tc.provider_metadata)) {
                    content.push({
                        type: 'thinking',
                        thinking: t.thinking,
                        signature: t.signature,
                    });
                }
            }
        }
        if (m.content) content.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: tc.arguments ? safeJsonParse(tc.arguments) : {},
                });
            }
        }
        if (content.length === 0) content.push({ type: 'text', text: '' });
        out.push({ role: 'assistant', content });
    }

    const result: { system?: string; messages: MessageParam[] } = { messages: out };
    if (systemTexts.length > 0) result.system = systemTexts.join('\n\n');
    return result;
}

function toAnthropicTools(req: CompleteRequest): Tool[] | undefined {
    if (!req.tools || req.tools.length === 0) return undefined;
    return req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Tool.InputSchema,
    }));
}

export function createAnthropicClient(opts: AnthropicClientOptions): ModelClient {
    const factory =
        opts.clientFactory ??
        (({ apiKey, baseUrl }): AnthropicLike => {
            const sdkOpts: { apiKey: string; baseURL?: string } = { apiKey };
            if (baseUrl) sdkOpts.baseURL = baseUrl;
            return new Anthropic(sdkOpts) as unknown as AnthropicLike;
        });
    const factoryOpts: { apiKey: string; baseUrl?: string } = { apiKey: opts.apiKey };
    if (opts.baseUrl) factoryOpts.baseUrl = opts.baseUrl;
    const client = factory(factoryOpts);

    return {
        async *complete(req) {
            const { system, messages } = toAnthropicRequest(req.messages);
            const tools = toAnthropicTools(req);
            const thinkingEnabled = req.reasoning === true;

            const params: MessageCreateParamsStreaming = {
                model: req.model,
                max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
                messages,
                stream: true,
            };
            if (system) {
                params.system = [
                    { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
                ];
            }
            if (tools) {
                tools[tools.length - 1]!.cache_control = { type: 'ephemeral' };
                params.tools = tools;
            }
            if (thinkingEnabled) {
                params.thinking = {
                    type: 'enabled',
                    budget_tokens: Math.min(
                        DEFAULT_THINKING_BUDGET,
                        (req.max_tokens ?? DEFAULT_MAX_TOKENS) - 1,
                    ),
                };
            } else if (req.temperature !== undefined) {
                params.temperature = req.temperature;
            }

            let stream: AsyncIterable<RawMessageStreamEvent>;
            try {
                stream = req.signal
                    ? await client.messages.create(params, { signal: req.signal })
                    : await client.messages.create(params);
            } catch (err) {
                throw new ModelInvocationError(
                    err instanceof Error ? err.message : 'anthropic stream open failed',
                    err,
                );
            }

            const toolCalls: ToolCall[] = [];
            const toolIndexToCall = new Map<number, ToolCall>();
            const thinkingBlocks: AnthropicThinking[] = [];
            const thinkingByIndex = new Map<number, { thinking: string; signature: string }>();
            let stopReason: string | undefined;

            try {
                for await (const event of stream) {
                    if (event.type === 'content_block_start') {
                        const block = event.content_block;
                        if (block.type === 'tool_use') {
                            const tc: ToolCall = {
                                id: block.id,
                                name: block.name,
                                arguments: '',
                            };
                            toolCalls.push(tc);
                            toolIndexToCall.set(event.index, tc);
                        } else if (block.type === 'thinking') {
                            thinkingByIndex.set(event.index, { thinking: '', signature: '' });
                        }
                        continue;
                    }
                    if (event.type === 'content_block_delta') {
                        const delta = event.delta;
                        if (delta.type === 'text_delta') {
                            if (delta.text.length > 0) yield { delta: delta.text };
                        } else if (delta.type === 'thinking_delta') {
                            const acc = thinkingByIndex.get(event.index);
                            if (acc) acc.thinking += delta.thinking;
                            yield { delta: '', reasoning: delta.thinking };
                        } else if (delta.type === 'signature_delta') {
                            const acc = thinkingByIndex.get(event.index);
                            if (acc) acc.signature += delta.signature;
                        } else if (delta.type === 'input_json_delta') {
                            const tc = toolIndexToCall.get(event.index);
                            if (tc) tc.arguments += delta.partial_json;
                        }
                        continue;
                    }
                    if (event.type === 'content_block_stop') {
                        const acc = thinkingByIndex.get(event.index);
                        if (acc && acc.signature.length > 0) {
                            thinkingBlocks.push({
                                thinking: acc.thinking,
                                signature: acc.signature,
                            });
                        }
                        continue;
                    }
                    if (event.type === 'message_delta') {
                        if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
                    }
                }
            } catch (err) {
                throw new ModelInvocationError(
                    err instanceof Error ? err.message : 'anthropic stream failed',
                    err,
                );
            }

            if (toolCalls.length > 0 && thinkingBlocks.length > 0) {
                toolCalls[0]!.provider_metadata = {
                    anthropic: { thinking: thinkingBlocks },
                };
            }

            yield {
                delta: '',
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                finish_reason: mapStopReason(stopReason),
            };
        },
    };
}

function mapStopReason(raw: string | undefined): string {
    if (!raw) return 'stop';
    switch (raw) {
        case 'end_turn':
        case 'stop_sequence':
            return 'stop';
        case 'max_tokens':
            return 'length';
        case 'tool_use':
            return 'tool_calls';
        case 'refusal':
            return 'content_filter';
        default:
            return raw.toLowerCase();
    }
}
