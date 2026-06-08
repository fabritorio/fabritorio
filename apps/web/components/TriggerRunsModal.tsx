'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import {
    type RunnerClient,
    type TriggerRunSummary,
    type TriggerRunsResult,
} from '@/lib/runner-client';
import { buildChatTurns } from '@/lib/webchat';
import { ChatTurnView } from '@/components/ChatTurnView';
import { EventTree } from '@/components/EventTree';
import { AskRowCollapsible } from '@/components/AskRowCollapsible';
import { isAskAgentResult } from '@/lib/ask-row-detection';
import { eventTimestampMs } from '@/lib/ask-call-detail';

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

export function TriggerRunsModal({ graphId, nodeId, nodeName, client, open, onClose }: Props) {
    const [result, setResult] = useState<TriggerRunsResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setSelectedEventId(null);
        void client
            .triggerRuns(graphId, nodeId, { limit: DEFAULT_LIMIT })
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
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const runs = result?.runs ?? [];
    const selectedRun = useMemo(
        () => runs.find((r) => r.eventId === selectedEventId) ?? null,
        [runs, selectedEventId],
    );

    const onLoadOlder = useCallback(async () => {
        if (runs.length === 0) return;
        const oldest = runs[runs.length - 1];
        if (!oldest) return;
        setLoading(true);
        setError(null);
        try {
            const next = await client.triggerRuns(graphId, nodeId, {
                before: new Date(oldest.timestamp).toISOString(),
                limit: DEFAULT_LIMIT,
            });
            setResult((prev) =>
                prev ? { source: next.source, runs: [...prev.runs, ...next.runs] } : next,
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [client, graphId, nodeId, runs]);

    const headerLabel = nodeName && nodeName.length > 0 ? nodeName : nodeId;

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-40 flex"
            role="dialog"
            aria-modal="true"
            aria-label={`Run history for ${headerLabel}`}
        >
            <div
                className="flex-1 bg-black/30 backdrop-blur-[1px]"
                onClick={onClose}
                aria-hidden="true"
            />
            <aside className="relative grid h-full w-full max-w-[600px] grid-rows-[auto_minmax(0,1fr)_auto] border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                    <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-wider text-rose-600 dark:text-rose-300">
                            Trigger runs
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
                <div className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)]">
                    <div className="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
                        {error && (
                            <div className="m-2 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                                {error}
                            </div>
                        )}
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            {loading && runs.length === 0 ? (
                                <LoadingRow />
                            ) : runs.length === 0 ? (
                                <EmptyState />
                            ) : (
                                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                                    {runs.map((run) => (
                                        <RunRow
                                            key={run.eventId}
                                            run={run}
                                            selected={run.eventId === selectedEventId}
                                            onSelect={() => setSelectedEventId(run.eventId)}
                                        />
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                    <div className="flex min-h-0 flex-col">
                        {selectedRun ? (
                            <RunDetail
                                graphId={graphId}
                                nodeId={nodeId}
                                run={selectedRun}
                                client={client}
                            />
                        ) : (
                            <SelectPrompt />
                        )}
                    </div>
                </div>
                <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
                    <span>
                        {runs.length > 0
                            ? `Showing ${runs.length} run${runs.length === 1 ? '' : 's'}`
                            : ''}
                    </span>
                    {runs.length >= DEFAULT_LIMIT && (
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

function RunRow({
    run,
    selected,
    onSelect,
}: {
    run: TriggerRunSummary;
    selected: boolean;
    onSelect: () => void;
}) {
    const time = formatRunTimestamp(run.timestamp);
    const downstream = formatDownstream(run.downstream);
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
                <div className="flex min-w-0 flex-col">
                    <span className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100">
                        {time}
                    </span>
                    <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                        {downstream}
                    </span>
                </div>
                <StatusBadge status={run.status} />
            </button>
        </li>
    );
}

function StatusBadge({ status }: { status: string }) {
    const cls =
        status === 'ok'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'
            : status === 'failed'
              ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200'
              : status === 'halted'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'
                : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
    return (
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
            {status}
        </span>
    );
}

function LoadingRow() {
    return <div className="p-3 text-[11px] text-zinc-500 dark:text-zinc-400">Loading runs…</div>;
}

function EmptyState() {
    return (
        <div className="p-4 text-[11px] text-zinc-500 dark:text-zinc-400">
            No runs yet — this trigger hasn't fired.
        </div>
    );
}

function SelectPrompt() {
    return (
        <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
            Select a run
        </div>
    );
}

type RunEvent = DispatchEvent | ObservabilityEvent;

function RunDetail({
    graphId,
    nodeId,
    run,
    client,
}: {
    graphId: string;
    nodeId: string;
    run: TriggerRunSummary;
    client: RunnerClient;
}) {
    const [events, setEvents] = useState<RunEvent[] | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [view, setView] = useState<'chat' | 'raw'>('chat');

    useEffect(() => {
        let cancelled = false;
        setEvents(null);
        setDetailError(null);
        void client
            .triggerRun(graphId, nodeId, run.eventId)
            .then((detail) => {
                if (cancelled) return;
                setEvents(detail.events);
            })
            .catch((err) => {
                if (cancelled) return;
                setDetailError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
    }, [client, graphId, nodeId, run.eventId]);

    const source = `trigger:${nodeId}`;
    const turns = useMemo(() => {
        if (!events) return [];
        return buildChatTurns({ events }, source, []);
    }, [events, source]);

    return (
        <div className="flex h-full flex-col">
            <div className="space-y-1 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-200">
                        {formatRunTimestamp(run.timestamp)}
                    </div>
                    <ViewToggle view={view} onChange={setView} />
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                    <StatusBadge status={run.status} />
                    <span>{formatDownstream(run.downstream)}</span>
                </div>
                <div className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                    {run.eventId}
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {detailError ? (
                    <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                        {detailError}
                    </div>
                ) : events === null ? (
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Loading run…</div>
                ) : view === 'chat' ? (
                    <ChatView turns={turns} />
                ) : (
                    <RawEventsTree graphId={graphId} events={events} client={client} />
                )}
            </div>
        </div>
    );
}

function RawEventsTree({
    graphId,
    events,
    client,
}: {
    graphId: string;
    events: ReadonlyArray<RunEvent>;
    client: RunnerClient;
}) {
    const startMs = events.length > 0 ? eventTimestampMs(events[0]!) : 0;
    return (
        <EventTree
            events={events}
            renderRow={(event) => {
                const match = isAskAgentResult(event, events);
                if (!match) return null;
                if (!('type' in event) || event.type !== 'tool.result') return null;
                return (
                    <AskRowCollapsible
                        graphId={graphId}
                        callerNodeId={match.callerNodeId}
                        calleeNodeId={match.calleeNodeId}
                        childEventId={match.childEventId}
                        toolResult={event}
                        treeStartMs={startMs}
                        eventMs={eventTimestampMs(event)}
                        client={client}
                    />
                );
            }}
        />
    );
}

function ViewToggle({
    view,
    onChange,
}: {
    view: 'chat' | 'raw';
    onChange: (next: 'chat' | 'raw') => void;
}) {
    const baseCls = 'rounded px-2 py-0.5 text-[10px] font-medium transition-colors';
    const activeCls = 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200';
    const idleCls = 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800';
    return (
        <div className="flex items-center gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
            <button
                type="button"
                onClick={() => onChange('chat')}
                className={`${baseCls} ${view === 'chat' ? activeCls : idleCls}`}
                aria-pressed={view === 'chat'}
            >
                Chat
            </button>
            <button
                type="button"
                onClick={() => onChange('raw')}
                className={`${baseCls} ${view === 'raw' ? activeCls : idleCls}`}
                aria-pressed={view === 'raw'}
            >
                Raw events
            </button>
        </div>
    );
}

function ChatView({ turns }: { turns: ReturnType<typeof buildChatTurns> }) {
    if (turns.length === 0) {
        return (
            <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                (no chat-shaped turns in this run)
            </div>
        );
    }
    return (
        <div className="space-y-3 text-xs">
            {turns.map((t, i) => (
                <ChatTurnView key={`${t.kind}-${t.rootEventId}-${i}`} turn={t} userVariant="zinc" />
            ))}
        </div>
    );
}

export function formatRunTimestamp(ts: number): string {
    if (!Number.isFinite(ts)) return '';
    return TIME_FMT.format(new Date(ts));
}

export function formatDownstream(downstream: ReadonlyArray<string>): string {
    if (downstream.length === 0) return '(no downstream)';
    const [first, ...rest] = downstream;
    if (rest.length === 0) return first ?? '';
    return `${first} +${rest.length}`;
}
