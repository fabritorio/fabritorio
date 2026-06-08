'use client';

import type { AssistantTurn, ChatTurn, ToolInvocation } from '@/lib/webchat';
import { MarkdownContent } from './MarkdownContent';

export type UserBubbleVariant = 'indigo' | 'fuchsia' | 'zinc';

const USER_BUBBLE: Record<UserBubbleVariant, string> = {
    indigo: 'bg-indigo-600 text-white',
    fuchsia: 'bg-fuchsia-600 text-white',
    zinc: 'bg-zinc-800 text-zinc-50 dark:bg-zinc-700 dark:text-zinc-50',
};

export type TriggerLookup = (triggerNodeId: string) => string | undefined;

export function ChatTurnView({
    turn,
    userVariant = 'indigo',
    triggerLookup,
}: {
    turn: ChatTurn;
    userVariant?: UserBubbleVariant;
    triggerLookup?: TriggerLookup;
}) {
    if (turn.kind === 'user') {
        return (
            <div className="flex justify-end">
                <div
                    className={`max-w-[85%] rounded-md px-2.5 py-1.5 shadow ${USER_BUBBLE[userVariant]}`}
                >
                    {turn.content || <em className="opacity-70">(empty)</em>}
                </div>
            </div>
        );
    }
    return <AssistantTurnView turn={turn} triggerLookup={triggerLookup} />;
}

function AssistantTurnView({
    turn,
    triggerLookup,
}: {
    turn: AssistantTurn;
    triggerLookup?: TriggerLookup;
}) {
    const triggerBadge = resolveTriggerBadge(turn, triggerLookup);
    return (
        <div className="flex flex-col gap-1.5">
            {triggerBadge && (
                <div className="self-start text-[10px] text-zinc-500 dark:text-zinc-400">
                    ⏰ Triggered by{' '}
                    <span className="font-mono text-zinc-600 dark:text-zinc-300">
                        {triggerBadge}
                    </span>
                </div>
            )}
            {turn.toolCalls.length > 0 && (
                <div className="space-y-1">
                    {turn.toolCalls.map((call) => (
                        <ToolCallView key={call.callId} call={call} />
                    ))}
                </div>
            )}
            <div className="max-w-[85%] self-start">
                <div
                    className={`rounded-md border px-2.5 py-1.5 ${
                        turn.errored
                            ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-100'
                            : 'border-zinc-200 bg-zinc-50 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100'
                    }`}
                >
                    {turn.content.length > 0 ? (
                        <MarkdownContent content={turn.content} />
                    ) : (
                        <em className="text-zinc-500 dark:text-zinc-500">
                            {turn.stopped ? '(stopped)' : '(thinking…)'}
                        </em>
                    )}
                </div>
                {turn.stopped && (
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                        <span aria-hidden>⏹</span>
                        <span>Stopped</span>
                    </div>
                )}
            </div>
        </div>
    );
}

const TRIGGER_SOURCE_PREFIX = 'trigger:';

function resolveTriggerBadge(
    turn: AssistantTurn,
    triggerLookup: TriggerLookup | undefined,
): string | null {
    if (!triggerLookup) return null;
    const source = turn.rootSource;
    if (!source || !source.startsWith(TRIGGER_SOURCE_PREFIX)) return null;
    const nodeId = source.slice(TRIGGER_SOURCE_PREFIX.length);
    return triggerLookup(nodeId) ?? nodeId;
}

function ToolCallView({ call }: { call: ToolInvocation }) {
    const args = JSON.stringify(call.args);
    return (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-100">
            <div className="font-mono">
                <span className="font-semibold">tool:</span> {call.name}
                <span className="text-amber-700/70 dark:text-amber-200/70">
                    {args.length > 80 ? `${args.slice(0, 80)}…` : args}
                </span>
            </div>
            {call.result && (
                <div className="mt-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-200">
                    → {summarizeResult(call.result)}
                </div>
            )}
        </div>
    );
}

function summarizeResult(result: NonNullable<ToolInvocation['result']>): string {
    if (result.exit_code !== 0) {
        const head = result.stderr || result.stdout || '';
        return `exit ${result.exit_code} ${head.slice(0, 120)}`;
    }
    const out = result.stdout.trim();
    if (out.length === 0) return '(ok, empty stdout)';
    return out.length > 120 ? `${out.slice(0, 120)}…` : out;
}
