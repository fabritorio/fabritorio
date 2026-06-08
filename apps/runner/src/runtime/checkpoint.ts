import type { CheckpointCadence } from '@fabritorio/types';
import type { BuiltinToolBuildCtx } from './builtin-tools.js';
import { publishAndAwaitAgentReply } from './builtin-tools.js';
import type { ChatMessage } from './model.js';

export const CHECKPOINT_DEFAULT_KEEP_LAST = 4;

export const CHECKPOINT_DEFAULT_CONTEXT_WINDOW = 128_000;

export interface ConsultResult {
    branch?: string;
    buffer_replacement?: ChatMessage[];
}

export interface CheckpointHandle {
    graphId: string;
    nodeId: string;
    strategy: 'supervisor' | 'mutator';
    consult(messages: ChatMessage[]): Promise<ConsultResult>;
}

export function checkpointKey(graphId: string, nodeId: string): string {
    return `${graphId}:${nodeId}`;
}

export interface CheckpointBinding {
    cadence: CheckpointCadence;
    handle: CheckpointHandle;
}

export interface CheckpointHandleConfig {
    graphId: string;
    nodeId: string;
    strategy: 'supervisor' | 'mutator';
    targetAgentId: string;
    window?: number;
    keepLast?: number;
    timeoutMs?: number;
}

export function createCheckpointHandle(
    buildCtx: BuiltinToolBuildCtx,
    config: CheckpointHandleConfig,
): CheckpointHandle {
    return {
        graphId: config.graphId,
        nodeId: config.nodeId,
        strategy: config.strategy,
        async consult(messages: ChatMessage[]): Promise<ConsultResult> {
            const conversation = messages.filter((m) => m.role !== 'system');
            const windowSlice =
                config.window !== undefined && config.window > 0
                    ? conversation.slice(-config.window)
                    : conversation;
            const brief = renderBrief(windowSlice);

            const result = await publishAndAwaitAgentReply(buildCtx, {
                targetAgentId: config.targetAgentId,
                brief,
                ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
            });

            if (result.kind !== 'ok') return {};

            if (config.strategy === 'supervisor') {
                return interpretSupervisor(result.content);
            }
            return interpretMutator(messages, result.content, config.keepLast);
        },
    };
}

function renderBrief(slice: ChatMessage[]): string {
    return slice
        .map((m) => {
            const calls =
                m.tool_calls && m.tool_calls.length > 0
                    ? ` [tool_calls: ${m.tool_calls.map((tc) => tc.name).join(', ')}]`
                    : '';
            return `${m.role}: ${m.content}${calls}`;
        })
        .join('\n');
}

export function interpretSupervisor(reply: string): ConsultResult {
    const text = reply.toLowerCase();
    const saysStop = /\bstop\b/.test(text);
    const saysContinue = /\bcontinue\b/.test(text);
    if (saysStop && !saysContinue) return { branch: 'done' };
    return {};
}

function interpretMutator(
    messages: ChatMessage[],
    summary: string,
    keepLast?: number,
): ConsultResult {
    const keep = keepLast !== undefined && keepLast > 0 ? keepLast : CHECKPOINT_DEFAULT_KEEP_LAST;

    const head: ChatMessage[] = [];
    let i = 0;
    while (i < messages.length && messages[i]!.role === 'system') {
        head.push(messages[i]!);
        i += 1;
    }

    const body = messages.slice(i);
    const tail = sliceLastTurns(body, keep);

    const summaryMessage: ChatMessage = {
        role: 'user',
        content: `[summary of earlier conversation]\n${summary}`,
    };

    return { buffer_replacement: [...head, summaryMessage, ...tail] };
}

function sliceLastTurns(messages: ChatMessage[], n: number): ChatMessage[] {
    let userSeen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === 'user') {
            userSeen += 1;
            if (userSeen === n) return messages.slice(i);
        }
    }
    return messages;
}
