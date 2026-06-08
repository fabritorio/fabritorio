import type { RouterEvent } from './providers/router.js';
import type { ToolSpec } from './tools.js';

export class ModelInvocationError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = 'ModelInvocationError';
    }
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
    provider_metadata?: Record<string, unknown>;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface CompleteRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
    temperature?: number;
    max_tokens?: number;
    reasoning?: boolean;
    routerEmit?: (event: RouterEvent) => void;
    signal?: AbortSignal;
}

export interface CompleteChunk {
    delta: string;
    reasoning?: string;
    tool_calls?: ToolCall[];
    finish_reason?: string;
}

export interface ModelClient {
    complete(req: CompleteRequest): AsyncIterable<CompleteChunk>;
}

export interface ModelEntry {
    id: string;
}

export interface ListModelsOptions {
    baseUrl?: string;
    authEnv?: string;
}

export type ModelLister = (opts: ListModelsOptions) => Promise<ModelEntry[]>;

export interface ToolCallAccumulator {
    id: string;
    name: string;
    arguments: string;
}

export function extractReasoningDelta(delta: unknown): string {
    if (!delta || typeof delta !== 'object') return '';
    const d = delta as Record<string, unknown>;
    if (typeof d.reasoning_content === 'string') return d.reasoning_content;
    if (typeof d.reasoning === 'string') return d.reasoning;
    return '';
}

export function mergeToolCallDeltas(
    accumulators: Map<number, ToolCallAccumulator>,
    deltas: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
    }>,
): void {
    for (const delta of deltas) {
        let acc = accumulators.get(delta.index);
        if (!acc) {
            acc = { id: '', name: '', arguments: '' };
            accumulators.set(delta.index, acc);
        }
        if (delta.id) acc.id = delta.id;
        if (delta.function?.name) acc.name = delta.function.name;
        if (delta.function?.arguments) acc.arguments += delta.function.arguments;
    }
}

export function finalizeToolCalls(accumulators: Map<number, ToolCallAccumulator>): ToolCall[] {
    return Array.from(accumulators.entries())
        .sort(([a], [b]) => a - b)
        .map(([, acc]) => ({
            id: acc.id,
            name: acc.name,
            arguments: acc.arguments,
        }));
}

export { createOpenAIClient, type OpenAIClientOptions } from './providers/openai-compat.js';
