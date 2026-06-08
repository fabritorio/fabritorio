import type { Message, ObservabilityEvent } from '@fabritorio/types';
import type { ChatMessage, ModelClient, ToolCall as ModelToolCall } from '../model.js';
import { redactSecrets } from '../secret-redaction.js';
import type { SecretsStore } from '../secrets-store.js';
import type { Tool } from '../tools.js';
import type { Handler, HandlerCtx, HandlerResult } from './handler.js';

export interface SimpleHandlerSkill {
    name: string;
    description: string;
}

export function buildSystemPrompt(args: {
    modelSystemPrompt?: string;
    skills: SimpleHandlerSkill[];
    injectedMemoryBlock?: string;
}): string {
    const parts: string[] = [];
    if (args.modelSystemPrompt && args.modelSystemPrompt.trim().length > 0) {
        parts.push(args.modelSystemPrompt.trim());
    }
    if (args.skills.length > 0) {
        const lines = ['Available skills (load full body via the Skill tool):'];
        for (const s of args.skills) {
            lines.push(`- ${s.name}: ${s.description}`);
        }
        parts.push(lines.join('\n'));
    }
    const block = args.injectedMemoryBlock?.trim();
    if (block && block.length > 0) parts.push(block);
    return parts.join('\n\n');
}

export function resolveSystemPrompt(sp: string | (() => string)): string {
    return typeof sp === 'function' ? sp() : sp;
}

function toChatMessages(messages: Message[]): ChatMessage[] {
    return messages.map((m): ChatMessage => {
        const base: ChatMessage = { role: m.role, content: m.content };
        if (m.tool_calls && m.tool_calls.length > 0) {
            base.tool_calls = m.tool_calls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments ?? {}),
            }));
        }
        if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
        return base;
    });
}

export interface SimpleHandlerOptions {
    model: ModelClient;
    modelId: string;
    modelNodeId: string;
    handlerNodeId: string;
    systemPrompt: string | (() => string);
    tools: Tool[];
    toolNodeIds: Map<string, string>;
    maxIterations?: number;
    temperature?: number;
    maxTokens?: number;
    reasoning?: boolean;
    eventId: string;
    emitObservability?: (event: ObservabilityEvent) => void;
    secretsStore?: SecretsStore;
}

export type SimpleHandlerResult = HandlerResult;

export interface SimpleHandlerBuildOptions {
    model: ModelClient;
    modelId: string;
    modelNodeId: string;
    handlerNodeId: string;
    systemPrompt: string | (() => string);
    tools: Tool[];
    toolNodeIds: Map<string, string>;
    maxIterations?: number;
    temperature?: number;
    maxTokens?: number;
    reasoning?: boolean;
    secretsStore?: SecretsStore;
}

export function createSimpleHandler(buildOpts: SimpleHandlerBuildOptions): Handler {
    return {
        async run(inbound: Message[], ctx: HandlerCtx): Promise<HandlerResult> {
            return runSimpleHandler(inbound, {
                ...buildOpts,
                eventId: ctx.eventId,
                ...(ctx.emitObservability ? { emitObservability: ctx.emitObservability } : {}),
            });
        },
    };
}

export async function runSimpleHandler(
    inbound: Message[],
    opts: SimpleHandlerOptions,
): Promise<SimpleHandlerResult> {
    const messages: ChatMessage[] = [];
    const systemPromptText = resolveSystemPrompt(opts.systemPrompt);
    if (systemPromptText.length > 0) {
        messages.push({ role: 'system', content: systemPromptText });
    }
    messages.push(...toChatMessages(inbound));

    const toolByName = new Map(opts.tools.map((t) => [t.spec.name, t]));
    const toolSpecs = opts.tools.map((t) => t.spec);
    const max = opts.maxIterations ?? 10;
    const emit = opts.emitObservability;

    for (let i = 0; i < max; i++) {
        const requestMessages = messages.map(
            (m): Message => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls
                    ? {
                          tool_calls: m.tool_calls.map((tc) => ({
                              id: tc.id,
                              name: tc.name,
                              arguments: safeJsonParse(tc.arguments),
                          })),
                      }
                    : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            }),
        );
        emit?.({
            ts: new Date().toISOString(),
            eventId: opts.eventId,
            parentId: opts.eventId,
            node_id: opts.modelNodeId,
            type: 'llm.request',
            model: opts.modelId,
            messages: requestMessages,
            ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
        });

        let textContent = '';
        let reasoning = '';
        let toolCalls: ModelToolCall[] = [];
        let finishReason: string | undefined;

        for await (const chunk of opts.model.complete({
            model: opts.modelId,
            messages,
            ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
            ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
        })) {
            if (chunk.delta) {
                textContent += chunk.delta;
                emit?.({
                    ts: new Date().toISOString(),
                    eventId: opts.eventId,
                    parentId: opts.eventId,
                    node_id: opts.modelNodeId,
                    type: 'llm.chunk',
                    delta: chunk.delta,
                    kind: 'content',
                });
            }
            if (chunk.reasoning) {
                reasoning += chunk.reasoning;
                emit?.({
                    ts: new Date().toISOString(),
                    eventId: opts.eventId,
                    parentId: opts.eventId,
                    node_id: opts.modelNodeId,
                    type: 'llm.chunk',
                    delta: chunk.reasoning,
                    kind: 'reasoning',
                });
            }
            if (chunk.tool_calls) toolCalls = chunk.tool_calls;
            if (chunk.finish_reason) finishReason = chunk.finish_reason;
        }

        emit?.({
            ts: new Date().toISOString(),
            eventId: opts.eventId,
            parentId: opts.eventId,
            node_id: opts.modelNodeId,
            type: 'llm.response',
            content: textContent,
            ...(reasoning ? { reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(toToolCallRecord) } : {}),
            finish_reason: finishReason ?? 'stop',
        });

        if (toolCalls.length > 0) {
            messages.push({
                role: 'assistant',
                content: textContent,
                tool_calls: toolCalls,
            });
            for (const tc of toolCalls) {
                const args = safeJsonParse(tc.arguments);
                const tool = toolByName.get(tc.name);
                const toolNodeId = opts.toolNodeIds.get(tc.name) ?? opts.handlerNodeId;
                emit?.({
                    ts: new Date().toISOString(),
                    eventId: opts.eventId,
                    parentId: opts.eventId,
                    node_id: toolNodeId,
                    type: 'tool.called',
                    tool_name: tc.name,
                    args,
                    call_id: tc.id,
                });

                let stdout = '';
                let stderr = '';
                let exit_code = 0;
                let child_event_id: string | undefined;
                if (!tool) {
                    stderr = `unknown tool: ${tc.name}`;
                    exit_code = 1;
                } else {
                    try {
                        const result = await tool.handler(args, {
                            call_id: tc.id,
                            eventId: opts.eventId,
                        });
                        stdout = result.stdout;
                        stderr = result.stderr;
                        exit_code = result.exit_code;
                        child_event_id = result.child_event_id;
                    } catch (err) {
                        stderr = err instanceof Error ? err.message : String(err);
                        exit_code = 1;
                    }
                }

                const secretValues = opts.secretsStore?.values() ?? [];
                if (secretValues.length > 0) {
                    stdout = redactSecrets(stdout, secretValues);
                    stderr = redactSecrets(stderr, secretValues);
                }

                emit?.({
                    ts: new Date().toISOString(),
                    eventId: opts.eventId,
                    parentId: opts.eventId,
                    node_id: toolNodeId,
                    type: 'tool.result',
                    call_id: tc.id,
                    stdout,
                    stderr,
                    exit_code,
                    ...(child_event_id ? { child_event_id } : {}),
                });

                const toolContent =
                    exit_code === 0 ? stdout : `[error] ${stderr || `exit ${exit_code}`}`;
                messages.push({
                    role: 'tool',
                    content: toolContent,
                    tool_call_id: tc.id,
                });
            }
            continue;
        }

        return {
            output: { role: 'assistant', content: textContent },
            errored: false,
        };
    }

    return {
        output: {
            role: 'assistant',
            content: `[error] handler stopped after ${max} iterations without producing a final answer`,
        },
        errored: true,
    };
}

function safeJsonParse(raw: string): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function toToolCallRecord(tc: ModelToolCall) {
    return {
        id: tc.id,
        name: tc.name,
        arguments: safeJsonParse(tc.arguments),
    };
}
