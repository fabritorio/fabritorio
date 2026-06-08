import { GoogleGenAI } from '@google/genai';
import type { Content, FunctionDeclaration, GenerateContentResponse, Part } from '@google/genai';
import {
    ModelInvocationError,
    type ChatMessage,
    type CompleteRequest,
    type ModelClient,
    type ToolCall,
} from '../model.js';

export interface GeminiClientOptions {
    apiKey: string;
    baseUrl?: string;
    clientFactory?: (opts: { apiKey: string; baseUrl?: string }) => GoogleGenAILike;
}

export interface GoogleGenAILike {
    models: {
        generateContentStream: (params: {
            model: string;
            contents: Content[];
            config?: Record<string, unknown>;
        }) => Promise<AsyncIterable<GenerateContentResponse>>;
    };
}

function readSignature(meta: ToolCall['provider_metadata']): string | undefined {
    if (!meta || typeof meta !== 'object') return undefined;
    const google = (meta as { google?: unknown }).google;
    if (!google || typeof google !== 'object') return undefined;
    const sig = (google as { thought_signature?: unknown }).thought_signature;
    return typeof sig === 'string' && sig.length > 0 ? sig : undefined;
}

function toGeminiRequest(messages: ChatMessage[]): {
    systemInstruction?: { parts: Part[] };
    contents: Content[];
} {
    const idToName = new Map<string, string>();
    for (const m of messages) {
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls) idToName.set(tc.id, tc.name);
        }
    }

    const systemTexts: string[] = [];
    const contents: Content[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            if (m.content) systemTexts.push(m.content);
            continue;
        }
        if (m.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: m.content }] });
            continue;
        }
        if (m.role === 'tool') {
            const name = idToName.get(m.tool_call_id ?? '') ?? '';
            contents.push({
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name,
                            response: { content: m.content },
                        },
                    },
                ],
            });
            continue;
        }
        const parts: Part[] = [];
        if (m.content) parts.push({ text: m.content });
        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                const args = tc.arguments ? safeJsonParse(tc.arguments) : {};
                const part: Part = { functionCall: { name: tc.name, args } };
                const sig = readSignature(tc.provider_metadata);
                if (sig) part.thoughtSignature = sig;
                parts.push(part);
            }
        }
        if (parts.length === 0) parts.push({ text: '' });
        contents.push({ role: 'model', parts });
    }

    const out: { systemInstruction?: { parts: Part[] }; contents: Content[] } = { contents };
    if (systemTexts.length > 0) {
        out.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
    }
    return out;
}

function safeJsonParse(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function toFunctionDeclarations(req: CompleteRequest): FunctionDeclaration[] | undefined {
    if (!req.tools || req.tools.length === 0) return undefined;
    return req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
    }));
}

export function createGeminiClient(opts: GeminiClientOptions): ModelClient {
    const factory =
        opts.clientFactory ??
        (({ apiKey, baseUrl }): GoogleGenAILike => {
            const sdkOpts: { apiKey: string; httpOptions?: { baseUrl: string } } = { apiKey };
            if (baseUrl) sdkOpts.httpOptions = { baseUrl };
            return new GoogleGenAI(sdkOpts) as unknown as GoogleGenAILike;
        });
    const factoryOpts: { apiKey: string; baseUrl?: string } = { apiKey: opts.apiKey };
    if (opts.baseUrl) factoryOpts.baseUrl = opts.baseUrl;
    const client = factory(factoryOpts);

    return {
        async *complete(req) {
            const { systemInstruction, contents } = toGeminiRequest(req.messages);
            const fnDecls = toFunctionDeclarations(req);
            const config: Record<string, unknown> = {
                thinkingConfig: { includeThoughts: req.reasoning === true },
            };
            if (systemInstruction) config.systemInstruction = systemInstruction;
            if (fnDecls) config.tools = [{ functionDeclarations: fnDecls }];
            if (req.temperature !== undefined) config.temperature = req.temperature;
            if (req.max_tokens !== undefined) config.maxOutputTokens = req.max_tokens;

            let stream: AsyncIterable<GenerateContentResponse>;
            try {
                stream = await client.models.generateContentStream({
                    model: req.model,
                    contents,
                    config,
                });
            } catch (err) {
                throw new ModelInvocationError(
                    err instanceof Error ? err.message : 'gemini stream open failed',
                    err,
                );
            }

            let lastFinishReason: string | undefined;
            const toolCalls: ToolCall[] = [];
            try {
                for await (const chunk of stream) {
                    const candidate = chunk.candidates?.[0];
                    if (!candidate) continue;
                    const parts = candidate.content?.parts ?? [];
                    for (const part of parts) {
                        if (part.functionCall) {
                            const fc = part.functionCall;
                            const args = fc.args ? JSON.stringify(fc.args) : '{}';
                            const tc: ToolCall = {
                                id: fc.id ?? `call_${toolCalls.length}_${Date.now()}`,
                                name: fc.name ?? '',
                                arguments: args,
                            };
                            if (part.thoughtSignature) {
                                tc.provider_metadata = {
                                    google: { thought_signature: part.thoughtSignature },
                                };
                            }
                            toolCalls.push(tc);
                            continue;
                        }
                        if (typeof part.text === 'string' && part.text.length > 0) {
                            if (part.thought) {
                                yield { delta: '', reasoning: part.text };
                            } else {
                                yield { delta: part.text };
                            }
                        }
                    }
                    if (candidate.finishReason) lastFinishReason = candidate.finishReason;
                }
            } catch (err) {
                throw new ModelInvocationError(
                    err instanceof Error ? err.message : 'gemini stream failed',
                    err,
                );
            }

            yield {
                delta: '',
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                finish_reason: mapFinishReason(lastFinishReason),
            };
        },
    };
}

function mapFinishReason(raw: string | undefined): string {
    if (!raw) return 'stop';
    switch (raw) {
        case 'STOP':
            return 'stop';
        case 'MAX_TOKENS':
            return 'length';
        case 'SAFETY':
        case 'BLOCKLIST':
        case 'PROHIBITED_CONTENT':
            return 'content_filter';
        default:
            return raw.toLowerCase();
    }
}
