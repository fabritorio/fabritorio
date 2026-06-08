'use client';

import { useEffect, useState } from 'react';
import type { AskCallDetail as AskCallDetailType, ToolResultEvent } from '@fabritorio/types';
import { AskCallDetail, StatusBadge } from './AskCallDetail';
import type { RunnerClient } from '@/lib/runner-client';

interface Props {
    graphId: string;
    callerNodeId: string;
    calleeNodeId: string;
    childEventId: string;
    toolResult: ToolResultEvent;
    treeStartMs: number;
    eventMs: number;
    client: RunnerClient;
}

export function AskRowCollapsible({
    graphId,
    callerNodeId,
    calleeNodeId,
    childEventId,
    toolResult,
    treeStartMs,
    eventMs,
    client,
}: Props) {
    const [open, setOpen] = useState(false);
    const [detail, setDetail] = useState<AskCallDetailType | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        if (detail !== null) return;
        let cancelled = false;
        setDetailError(null);
        void client
            .agentCallDetail(graphId, callerNodeId, childEventId)
            .then((next) => {
                if (cancelled) return;
                setDetail(next);
            })
            .catch((err) => {
                if (cancelled) return;
                setDetailError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
    }, [open, detail, client, graphId, callerNodeId, childEventId]);

    const status = toolResultStatus(toolResult);
    const offsetText = formatOffset(eventMs - treeStartMs);

    return (
        <details
            className="rounded border border-rose-200 bg-rose-50/40 px-2 py-1 text-[11px] text-zinc-700 open:bg-white dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-zinc-300 dark:open:bg-zinc-950"
            onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
            <summary className="flex cursor-pointer items-center justify-between gap-2 font-mono">
                <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400 dark:text-zinc-500">→</span>
                    <span className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                        {calleeNodeId}
                    </span>
                    <StatusBadge status={status} />
                </div>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-500">{offsetText}</span>
            </summary>
            <div className="mt-2">
                {detailError ? (
                    <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                        {detailError}
                    </div>
                ) : detail === null ? (
                    <div className="px-1 py-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                        Loading call…
                    </div>
                ) : (
                    <div className="max-h-[32rem] overflow-y-auto rounded border border-zinc-200 dark:border-zinc-800">
                        <AskCallDetail
                            detail={detail}
                            askContext={{ graphId, client }}
                            liveContext={{ graphId, eventId: childEventId, client }}
                        />
                    </div>
                )}
            </div>
        </details>
    );
}

function toolResultStatus(event: ToolResultEvent): 'ok' | 'failed' {
    return event.exit_code === 0 ? 'ok' : 'failed';
}

function formatOffset(deltaMs: number): string {
    if (!Number.isFinite(deltaMs)) return '';
    if (deltaMs < 1000) return `+${Math.round(deltaMs)}ms`;
    return `+${(deltaMs / 1000).toFixed(2)}s`;
}
