'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AskCallDetail as AskCallDetailType, AskCallSummary } from '@fabritorio/types';
import { type AgentCallsResult, type RunnerClient } from '@/lib/runner-client';
import { AskCallDetail, StatusBadge } from './AskCallDetail';
import { formatDuration } from '@/lib/ask-call-detail';
import { applyCompletedEvent, applyStartedEvent } from '@/lib/asks-stream-merge';

const DEFAULT_LIMIT = 50;

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium',
});

interface Props {
    graphId: string;
    nodeId: string;
    nodeName?: string;
    client: RunnerClient;
    open: boolean;
    onClose: () => void;
}

export function AskCallsModal({ graphId, nodeId, nodeName, client, open, onClose }: Props) {
    const [result, setResult] = useState<AgentCallsResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
    const [, setTick] = useState(0);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setSelectedEventId(null);
        void client
            .agentCalls(graphId, nodeId, { limit: DEFAULT_LIMIT })
            .then((next) => {
                if (cancelled) return;
                setResult(next);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [client, graphId, nodeId, open]);

    useEffect(() => {
        if (!open) return;
        const source = client.agentAsksStream(graphId, nodeId, {
            started: (ev) => {
                setResult((prev) => {
                    const base: AgentCallsResult = prev ?? { callerNodeId: nodeId, calls: [] };
                    const nextCalls = applyStartedEvent(base.calls, ev, nodeId);
                    if (nextCalls === base.calls) return prev;
                    return { callerNodeId: base.callerNodeId, calls: nextCalls };
                });
            },
            completed: (ev) => {
                setResult((prev) => {
                    if (!prev) return prev;
                    const nextCalls = applyCompletedEvent(prev.calls, ev);
                    if (nextCalls === prev.calls) return prev;
                    return { callerNodeId: prev.callerNodeId, calls: nextCalls };
                });
            },
        });
        return () => source.close();
    }, [client, graphId, nodeId, open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const calls = result?.calls ?? [];
    const selectedCall = useMemo(
        () => calls.find((c) => c.eventId === selectedEventId) ?? null,
        [calls, selectedEventId],
    );

    const hasRunning = useMemo(() => calls.some((c) => c.status === 'running'), [calls]);
    useEffect(() => {
        if (!open || !hasRunning) return;
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [open, hasRunning]);

    const onLoadOlder = useCallback(async () => {
        if (calls.length === 0) return;
        const oldest = calls[calls.length - 1];
        if (!oldest) return;
        setLoading(true);
        setError(null);
        try {
            const next = await client.agentCalls(graphId, nodeId, {
                before: new Date(oldest.startedAt).toISOString(),
                limit: DEFAULT_LIMIT,
            });
            setResult((prev) =>
                prev
                    ? { callerNodeId: next.callerNodeId, calls: [...prev.calls, ...next.calls] }
                    : next,
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [client, graphId, nodeId, calls]);

    const headerLabel = nodeName && nodeName.length > 0 ? nodeName : nodeId;

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-40 flex"
            role="dialog"
            aria-modal="true"
            aria-label={`Outbound asks for ${headerLabel}`}
        >
            <div
                className="flex-1 bg-black/30 backdrop-blur-[1px]"
                onClick={onClose}
                aria-hidden="true"
            />
            <aside className="relative grid h-full w-full max-w-[720px] grid-rows-[auto_minmax(0,1fr)_auto] border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                    <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-wider text-rose-600 dark:text-rose-300">
                            Outbound asks
                        </span>
                        <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                            {headerLabel}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                        ×
                    </button>
                </div>
                <div className="grid min-h-0 grid-cols-[320px_minmax(0,1fr)]">
                    <div className="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
                        {error && (
                            <div className="m-2 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                                {error}
                            </div>
                        )}
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            {loading && calls.length === 0 ? (
                                <LoadingRow />
                            ) : calls.length === 0 ? (
                                <EmptyState />
                            ) : (
                                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                                    {calls.map((call) => (
                                        <CallRow
                                            key={call.eventId}
                                            call={call}
                                            selected={call.eventId === selectedEventId}
                                            onSelect={() => setSelectedEventId(call.eventId)}
                                        />
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                    <div className="flex min-h-0 flex-col">
                        {selectedCall ? (
                            <CallDetailPane
                                graphId={graphId}
                                nodeId={nodeId}
                                call={selectedCall}
                                client={client}
                            />
                        ) : (
                            <SelectPrompt />
                        )}
                    </div>
                </div>
                <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
                    <span>
                        {calls.length > 0
                            ? `Showing ${calls.length} call${calls.length === 1 ? '' : 's'}`
                            : ''}
                    </span>
                    {calls.length >= DEFAULT_LIMIT && (
                        <button
                            type="button"
                            onClick={onLoadOlder}
                            disabled={loading}
                            className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                            {loading ? 'Loading…' : 'Load older'}
                        </button>
                    )}
                </div>
            </aside>
        </div>
    );
}

function CallRow({
    call,
    selected,
    onSelect,
}: {
    call: AskCallSummary;
    selected: boolean;
    onSelect: () => void;
}) {
    const time = formatAskTimestamp(call.startedAt);
    return (
        <li>
            <button
                type="button"
                onClick={onSelect}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] transition-colors ${
                    selected
                        ? 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100'
                        : 'text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/60'
                }`}
            >
                <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                        <span className="text-zinc-400 dark:text-zinc-500">→</span>
                        <span className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                            {call.calleeNodeId}
                        </span>
                    </div>
                    <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        {time}
                    </span>
                    {call.briefSnippet && (
                        <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                            {call.briefSnippet}
                        </span>
                    )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <StatusBadge status={call.status} />
                    <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        {call.status === 'running'
                            ? formatDuration(Math.max(0, Date.now() - call.startedAt))
                            : formatDuration(call.durationMs)}
                    </span>
                </div>
            </button>
        </li>
    );
}

function CallDetailPane({
    graphId,
    nodeId,
    call,
    client,
}: {
    graphId: string;
    nodeId: string;
    call: AskCallSummary;
    client: RunnerClient;
}) {
    const [detail, setDetail] = useState<AskCallDetailType | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setDetail(null);
        setDetailError(null);
        void client
            .agentCallDetail(graphId, nodeId, call.eventId)
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
    }, [client, graphId, nodeId, call.eventId]);

    if (detailError) {
        return (
            <div className="m-3 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                {detailError}
            </div>
        );
    }
    if (detail === null) {
        return <div className="p-3 text-[11px] text-zinc-500 dark:text-zinc-400">Loading…</div>;
    }
    return (
        <AskCallDetail
            detail={detail}
            askContext={{ graphId, client }}
            liveContext={{ graphId, eventId: call.eventId, client }}
        />
    );
}

function LoadingRow() {
    return <div className="p-3 text-[11px] text-zinc-500 dark:text-zinc-400">Loading…</div>;
}

function EmptyState() {
    return (
        <div className="p-4 text-[11px] text-zinc-500 dark:text-zinc-400">
            No outbound asks yet — this agent hasn't called another agent.
        </div>
    );
}

function SelectPrompt() {
    return (
        <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
            Select a call
        </div>
    );
}

export function formatAskTimestamp(ts: number): string {
    if (!Number.isFinite(ts)) return '';
    return TIME_FMT.format(new Date(ts));
}
