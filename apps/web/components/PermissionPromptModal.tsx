'use client';

import { useEffect, useState } from 'react';
import type { PermissionDecision, PermissionDecisionRequest } from '@/lib/runner-client';

export interface PermissionPromptModalProps {
    queue: PermissionDecisionRequest[];
    onDecide: (req: PermissionDecisionRequest, decision: PermissionDecision) => void;
}

export function PermissionPromptModal({ queue, onDecide }: PermissionPromptModalProps) {
    const head = queue[0] ?? null;
    const [busyCallId, setBusyCallId] = useState<string | null>(null);

    useEffect(() => {
        if (!head || head.callId !== busyCallId) {
            setBusyCallId(null);
        }
    }, [head, busyCallId]);

    if (!head) return null;

    const argsJson = JSON.stringify(head.args, null, 2);
    const allowAlwaysLabel = head.argSignature
        ? `Allow always (${head.toolName} starting with \`${head.argSignature}\`)`
        : `Allow always (${head.toolName})`;

    const decide = (decision: PermissionDecision) => {
        if (busyCallId) return;
        setBusyCallId(head.callId);
        onDecide(head, decision);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-md border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                <div className="text-[10px] uppercase tracking-wider text-red-600 dark:text-red-400">
                    Permission required
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                        Run <code className="font-mono text-base">{head.toolName}</code>?
                    </h2>
                    {queue.length > 1 ? (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            ({queue.length - 1} more queued)
                        </span>
                    ) : null}
                </div>
                <pre className="mt-3 max-h-64 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
                    {argsJson}
                </pre>
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    <button
                        type="button"
                        disabled={busyCallId === head.callId}
                        onClick={() => decide('deny')}
                        className="rounded border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-400/40 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-500/10"
                    >
                        Deny
                    </button>
                    <button
                        type="button"
                        disabled={busyCallId === head.callId}
                        onClick={() => decide('allow-once')}
                        className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                        Allow once
                    </button>
                    <button
                        type="button"
                        disabled={busyCallId === head.callId}
                        onClick={() => decide('allow-always')}
                        className="rounded border border-emerald-400 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200 dark:hover:bg-emerald-500/20"
                        title={`Future calls matching this scope skip the prompt for the rest of this session.`}
                    >
                        {allowAlwaysLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
