import type { Edge, Graph, Message } from '@fabritorio/types';
import type { CheckpointBinding } from '../checkpoint.js';
import { CHECKPOINT_DEFAULT_CONTEXT_WINDOW } from '../checkpoint.js';
import { estimateTokens } from '../memory.js';
import type { ChatMessage, ModelClient, ToolCall as ModelToolCall } from '../model.js';
import type { PermissionGateHandle } from '../permission.js';
import type { RouterEvent } from '../providers/router.js';
import type { Tool } from '../tools.js';
import type { SecretsStore } from '../secrets-store.js';
import { redactSecrets } from '../secret-redaction.js';
import type { Handler, HandlerCtx, HandlerResult } from './handler.js';
import { resolveSystemPrompt } from './system-prompt.js';

const MAX_PRIMITIVE_STEPS = 200;

export interface GraphHandlerBuildOptions {
    graph: Graph;
    model: ModelClient;
    modelId: string;
    modelNodeId: string;
    handlerNodeId: string;
    systemPrompt: string | (() => string);
    tools: Tool[];
    toolNodeIds: Map<string, string>;
    permissionByToolName?: Map<string, PermissionGateHandle>;
    checkpoints?: CheckpointBinding[];
    contextWindow?: number;
    maxIterations?: number;
    temperature?: number;
    maxTokens?: number;
    reasoning?: boolean;
    secretsStore?: SecretsStore;
}

type Topology = Map<string, Map<string | null, string>>;

interface CompiledGraph {
    inputId: string;
    byId: Map<string, Graph['nodes'][number]>;
    topology: Topology;
}

export function createGraphHandler(opts: GraphHandlerBuildOptions): Handler {
    const compiled = compileHandlerGraph(opts.graph);
    return {
        async run(inbound: Message[], ctx: HandlerCtx): Promise<HandlerResult> {
            return runGraph(compiled, inbound, opts, ctx);
        },
    };
}

export function compileHandlerGraph(graph: Graph): CompiledGraph {
    const inputs = graph.nodes.filter((n) => n.type === 'handler_input');
    if (inputs.length !== 1) {
        throw new Error(
            `handler graph ${graph.id ?? '(unsaved)'}: expected exactly 1 handler_input, got ${inputs.length}`,
        );
    }
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const topology: Topology = new Map();
    for (const edge of graph.edges as Edge[]) {
        const port = edge.source.port_id ?? null;
        let bucket = topology.get(edge.source.node_id);
        if (!bucket) {
            bucket = new Map();
            topology.set(edge.source.node_id, bucket);
        }
        bucket.set(port, edge.target.node_id);
    }
    return { inputId: inputs[0]!.id, byId, topology };
}

async function runGraph(
    compiled: CompiledGraph,
    inbound: Message[],
    opts: GraphHandlerBuildOptions,
    ctx: HandlerCtx,
): Promise<HandlerResult> {
    const messages: ChatMessage[] = [];
    const toolByName = new Map(opts.tools.map((t) => [t.spec.name, t]));
    const max = opts.maxIterations ?? 10;
    const contextWindow = opts.contextWindow ?? CHECKPOINT_DEFAULT_CONTEXT_WINDOW;
    let modelCalls = 0;
    const tokenCadenceArmed = new Set<CheckpointBinding>();

    let currentId: string | null = compiled.inputId;
    let chosenPort: string | null = null;

    for (let step = 0; step < MAX_PRIMITIVE_STEPS; step++) {
        if (ctx.signal?.aborted) return stoppedResult(messages, opts, ctx);
        if (currentId === null) {
            return errorResult('handler graph terminated with no outgoing edge', opts, ctx);
        }
        const node = compiled.byId.get(currentId);
        if (!node) {
            return errorResult(`handler graph: missing node ${currentId}`, opts, ctx);
        }

        switch (node.type) {
            case 'handler_input': {
                chosenPort = null;
                break;
            }
            case 'prompt_builder': {
                const systemPromptText = resolveSystemPrompt(opts.systemPrompt);
                if (systemPromptText.length > 0) {
                    messages.push({ role: 'system', content: systemPromptText });
                }
                messages.push(...toChatMessages(inbound));
                chosenPort = null;
                break;
            }
            case 'model_call': {
                if (modelCalls >= max) {
                    return errorResult(
                        `handler stopped after ${max} model calls without producing a final answer`,
                        opts,
                        ctx,
                    );
                }
                modelCalls += 1;
                try {
                    await runModelCall(messages, opts, ctx);
                } catch (err) {
                    if (ctx.signal?.aborted) return stoppedResult(messages, opts, ctx);
                    throw err;
                }
                chosenPort = null;
                break;
            }
            case 'tool_exec': {
                try {
                    await runToolExec(messages, toolByName, opts, ctx);
                } catch (err) {
                    if (ctx.signal?.aborted) return stoppedResult(messages, opts, ctx);
                    throw err;
                }
                chosenPort = null;
                break;
            }
            case 'evaluator': {
                chosenPort = decideEvaluatorPort(messages);
                const due = checkpointsDue(
                    opts.checkpoints,
                    modelCalls,
                    messages,
                    contextWindow,
                    tokenCadenceArmed,
                );
                for (const binding of due) {
                    const result = await binding.handle.consult(messages);
                    if (result.branch !== undefined) {
                        chosenPort = result.branch;
                    }
                    if (result.buffer_replacement !== undefined) {
                        messages.length = 0;
                        messages.push(...result.buffer_replacement);
                    }
                }
                break;
            }
            case 'handler_output': {
                const finalMessage = lastAssistantMessage(messages);
                return {
                    output: finalMessage,
                    errored: false,
                };
            }
            default: {
                return errorResult(`handler graph: unsupported node type ${node.type}`, opts, ctx);
            }
        }

        const outgoing = compiled.topology.get(currentId);
        if (!outgoing || outgoing.size === 0) {
            return errorResult(
                `handler graph: no outgoing edge from ${currentId} (${node.type})`,
                opts,
                ctx,
            );
        }
        const next =
            outgoing.get(chosenPort) ?? (chosenPort !== null ? outgoing.get(null) : undefined);
        if (!next) {
            return errorResult(
                `handler graph: no outgoing edge from ${currentId} on port ${chosenPort ?? '(default)'}`,
                opts,
                ctx,
            );
        }
        currentId = next;
    }

    return errorResult(
        `handler graph: hit interpreter step limit (${MAX_PRIMITIVE_STEPS})`,
        opts,
        ctx,
    );
}

function decideEvaluatorPort(messages: ChatMessage[]): string {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
        return 'tools';
    }
    return 'done';
}

function estimateChatMessageTokens(m: ChatMessage): number {
    return estimateTokens({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls
            ? {
                  tool_calls: m.tool_calls.map((tc) => ({
                      id: tc.id,
                      name: tc.name,
                      arguments: safeJsonParse(tc.arguments),
                  })),
              }
            : {}),
    });
}

function checkpointsDue(
    checkpoints: CheckpointBinding[] | undefined,
    modelCalls: number,
    messages: ChatMessage[],
    contextWindow: number,
    armed: Set<CheckpointBinding>,
): CheckpointBinding[] {
    if (!checkpoints || checkpoints.length === 0) return [];
    let bufferTokens: number | undefined;
    const due: CheckpointBinding[] = [];
    for (const c of checkpoints) {
        if (c.cadence.kind === 'iterations') {
            if (c.cadence.at.includes(modelCalls)) due.push(c);
            continue;
        }
        if (bufferTokens === undefined) {
            bufferTokens = messages.reduce((sum, m) => sum + estimateChatMessageTokens(m), 0);
        }
        const threshold = contextWindow * c.cadence.at_fraction;
        const over = bufferTokens >= threshold;
        if (over && !armed.has(c)) {
            armed.add(c);
            due.push(c);
        } else if (!over) {
            armed.delete(c);
        }
    }
    return due;
}

function lastAssistantMessage(messages: ChatMessage[]): Message {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === 'assistant') {
            return { role: 'assistant', content: m.content };
        }
    }
    return { role: 'assistant', content: '' };
}

async function runModelCall(
    messages: ChatMessage[],
    opts: GraphHandlerBuildOptions,
    ctx: HandlerCtx,
): Promise<void> {
    const toolSpecs = opts.tools.map((t) => t.spec);
    const emit = ctx.emitObservability;

    const routerEmit: ((re: RouterEvent) => void) | undefined = emit
        ? (re: RouterEvent) => {
              const base = {
                  ts: new Date().toISOString(),
                  eventId: ctx.eventId,
                  parentId: ctx.eventId,
                  node_id: re.routerId,
              };
              if (re.type === 'model_router.attempted') {
                  emit({
                      ...base,
                      type: 'model_router.attempted',
                      model_node_id: re.modelNodeId,
                      model_id: re.modelId,
                      attempt: re.attempt,
                  });
              } else {
                  emit({
                      ...base,
                      type: 'model_router.fell_through',
                      from_model_node_id: re.fromModelNodeId,
                      from_model_id: re.fromModelId,
                      to_model_node_id: re.toModelNodeId,
                      to_model_id: re.toModelId,
                      reason: re.reason,
                  });
              }
          }
        : undefined;

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
        eventId: ctx.eventId,
        parentId: ctx.eventId,
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
        ...(routerEmit ? { routerEmit } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    })) {
        if (ctx.signal?.aborted) break;
        if (chunk.delta) {
            textContent += chunk.delta;
            emit?.({
                ts: new Date().toISOString(),
                eventId: ctx.eventId,
                parentId: ctx.eventId,
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
                eventId: ctx.eventId,
                parentId: ctx.eventId,
                node_id: opts.modelNodeId,
                type: 'llm.chunk',
                delta: chunk.reasoning,
                kind: 'reasoning',
            });
        }
        if (chunk.tool_calls) toolCalls = chunk.tool_calls;
        if (chunk.finish_reason) finishReason = chunk.finish_reason;
    }

    if (ctx.signal?.aborted) {
        throw new Error('dispatch stopped');
    }

    emit?.({
        ts: new Date().toISOString(),
        eventId: ctx.eventId,
        parentId: ctx.eventId,
        node_id: opts.modelNodeId,
        type: 'llm.response',
        content: textContent,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(toToolCallRecord) } : {}),
        finish_reason: finishReason ?? 'stop',
    });

    messages.push({
        role: 'assistant',
        content: textContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
}

async function runToolExec(
    messages: ChatMessage[],
    toolByName: Map<string, Tool>,
    opts: GraphHandlerBuildOptions,
    ctx: HandlerCtx,
): Promise<void> {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.tool_calls) return;
    const emit = ctx.emitObservability;

    for (const tc of last.tool_calls) {
        if (ctx.signal?.aborted) break;
        const args = safeJsonParse(tc.arguments);
        const tool = toolByName.get(tc.name);
        const toolNodeId = opts.toolNodeIds.get(tc.name) ?? opts.handlerNodeId;
        emit?.({
            ts: new Date().toISOString(),
            eventId: ctx.eventId,
            parentId: ctx.eventId,
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
        const gate = opts.permissionByToolName?.get(tc.name);
        let denied = false;
        if (gate) {
            const signature = tool?.argSignature?.(args);
            const decision = await gate.evaluate({
                tool_name: tc.name,
                args,
                call_id: tc.id,
                ...(signature ? { signature } : {}),
            });
            if (decision === 'deny') {
                denied = true;
                stderr = '[denied by user]';
                exit_code = 1;
            }
        }
        if (!denied) {
            if (!tool) {
                stderr = `unknown tool: ${tc.name}`;
                exit_code = 1;
            } else {
                try {
                    const result = await tool.handler(args, {
                        call_id: tc.id,
                        eventId: ctx.eventId,
                        ...(ctx.signal ? { signal: ctx.signal } : {}),
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
        }

        const secretValues = opts.secretsStore?.values() ?? [];
        if (secretValues.length > 0) {
            stdout = redactSecrets(stdout, secretValues);
            stderr = redactSecrets(stderr, secretValues);
        }

        emit?.({
            ts: new Date().toISOString(),
            eventId: ctx.eventId,
            parentId: ctx.eventId,
            node_id: toolNodeId,
            type: 'tool.result',
            call_id: tc.id,
            stdout,
            stderr,
            exit_code,
            ...(child_event_id ? { child_event_id } : {}),
        });

        const toolContent = exit_code === 0 ? stdout : `[error] ${stderr || `exit ${exit_code}`}`;
        messages.push({
            role: 'tool',
            content: toolContent,
            tool_call_id: tc.id,
        });
    }
}

function errorResult(
    message: string,
    _opts: GraphHandlerBuildOptions,
    _ctx: HandlerCtx,
): HandlerResult {
    return {
        output: { role: 'assistant', content: `[error] ${message}` },
        errored: true,
    };
}

export function repairStoppedBuffer(messages: ChatMessage[]): void {
    let last: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === 'assistant') {
            last = messages[i];
            break;
        }
    }
    if (!last || !last.tool_calls || last.tool_calls.length === 0) {
        return;
    }
    const answered = new Set<string>();
    for (const m of messages) {
        if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id);
    }
    for (const tc of last.tool_calls) {
        if (answered.has(tc.id)) continue;
        messages.push({
            role: 'tool',
            content: '[cancelled by user]',
            tool_call_id: tc.id,
        });
    }
}

function stoppedResult(
    messages: ChatMessage[],
    _opts: GraphHandlerBuildOptions,
    ctx: HandlerCtx,
): HandlerResult {
    repairStoppedBuffer(messages);
    ctx.emitObservability?.({
        ts: new Date().toISOString(),
        eventId: ctx.eventId,
        parentId: ctx.eventId,
        node_id: ctx.eventId,
        type: 'dispatch.stopped',
        reason: 'stopped by user',
    });
    return {
        output: lastAssistantMessage(messages),
        errored: false,
        stopped: true,
    };
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
