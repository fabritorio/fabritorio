'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskCallDetail, DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import { MarkdownContent } from './MarkdownContent';
import { EventTree } from './EventTree';
import { AskRowCollapsible } from './AskRowCollapsible';
import {
    ASK_CALL_TABS,
    eventTimestampMs,
    formatDuration,
    statusBadgeClass,
    type AskCallTab,
} from '@/lib/ask-call-detail';
import { isAskAgentResult } from '@/lib/ask-row-detection';
import type { RunnerClient } from '@/lib/runner-client';

interface Props {
    detail: AskCallDetail;
    askContext?: { graphId: string; client: RunnerClient };
    liveContext?: { graphId: string; eventId: string; client: RunnerClient };
}

export function AskCallDetail({ detail, askContext, liveContext }: Props) {
    const [tab, setTab] = useState<AskCallTab>('call');

    return (
        <div className="flex h-full min-h-0 flex-col">
            <TabBar tab={tab} onChange={setTab} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {tab === 'call' ? (
                    <CallTab detail={detail} />
                ) : tab === 'response' ? (
                    <ResponseTab detail={detail} />
                ) : (
                    <InternalTab
                        detail={detail}
                        askContext={askContext}
                        liveContext={liveContext}
                    />
                )}
            </div>
        </div>
    );
}

function TabBar({ tab, onChange }: { tab: AskCallTab; onChange: (next: AskCallTab) => void }) {
    return (
        <div
            role="tablist"
            aria-label="Ask call detail"
            className="flex items-center gap-1 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800"
        >
            {ASK_CALL_TABS.map((t) => {
                const active = t.id === tab;
                return (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onChange(t.id)}
                        className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                            active
                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200'
                                : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                        }`}
                    >
                        {t.label}
                    </button>
                );
            })}
        </div>
    );
}

function CallTab({ detail }: { detail: AskCallDetail }) {
    return (
        <div className="space-y-4 px-4 py-3">
            <FieldRow label="From">
                <NodeChip id={detail.call.callerNodeId} />
                <span className="text-zinc-400 dark:text-zinc-500">→</span>
                <NodeChip id={detail.call.calleeNodeId} />
            </FieldRow>
            <FieldRow label="Ask chain">
                <AskChainBreadcrumb chain={detail.call.askChain} />
            </FieldRow>
            <FieldRow label="Inherit session">
                <span className="text-[11px] text-zinc-700 dark:text-zinc-300">
                    {detail.call.inheritSession ? 'yes' : 'no'}
                </span>
            </FieldRow>
            <FieldRow label="Timeout">
                <span className="text-[11px] text-zinc-700 dark:text-zinc-300">
                    {detail.call.timeoutMs}ms
                </span>
            </FieldRow>
            <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                    Brief
                </div>
                {detail.call.brief.length === 0 ? (
                    <div className="text-[11px] text-zinc-400 dark:text-zinc-500">(empty)</div>
                ) : (
                    <div className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-[12px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200">
                        <MarkdownContent content={detail.call.brief} />
                    </div>
                )}
            </div>
        </div>
    );
}

function ResponseTab({ detail }: { detail: AskCallDetail }) {
    const { response } = detail;
    return (
        <div className="space-y-4 px-4 py-3">
            <FieldRow label="Status">
                <StatusBadge status={response.status} />
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {formatDuration(response.durationMs)}
                </span>
            </FieldRow>
            <FieldRow label="Exit code">
                <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                    {response.exitCode}
                </span>
            </FieldRow>
            <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                    {response.status === 'failed' ? 'Error output' : 'Stdout'}
                </div>
                {response.status === 'running' ? (
                    <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                        Awaiting reply…
                    </div>
                ) : response.stdout.length === 0 ? (
                    <div className="text-[11px] text-zinc-400 dark:text-zinc-500">(empty)</div>
                ) : (
                    <pre
                        className={`max-h-[28rem] overflow-auto rounded border px-2 py-1 text-[11px] leading-tight ${
                            response.status === 'failed'
                                ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200'
                                : 'border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200'
                        }`}
                    >
                        {response.stdout}
                    </pre>
                )}
            </div>
        </div>
    );
}

type AnyEvent = DispatchEvent | ObservabilityEvent;

function InternalTab({
    detail,
    askContext,
    liveContext,
}: {
    detail: AskCallDetail;
    askContext?: { graphId: string; client: RunnerClient };
    liveContext?: { graphId: string; eventId: string; client: RunnerClient };
}) {
    const initialEvents = detail.internal;
    const [eventsBySeq, setEventsBySeq] = useState<Map<number, AnyEvent>>(() => {
        const m = new Map<number, AnyEvent>();
        for (let i = 0; i < initialEvents.length; i++) m.set(i, initialEvents[i]!);
        return m;
    });
    const [liveAppended, setLiveAppended] = useState<ReadonlySet<number>>(() => new Set());
    const [streamEnded, setStreamEnded] = useState(false);
    const initialSeqMaxRef = useRef(initialEvents.length - 1);

    const callIsRunning = detail.response.status === 'running';
    const isLive = !!liveContext && callIsRunning && !streamEnded;

    const liveGraphId = liveContext?.graphId;
    const liveEventId = liveContext?.eventId;
    const liveClient = liveContext?.client;

    useEffect(() => {
        if (!liveGraphId || !liveEventId || !liveClient) return;
        if (!callIsRunning) return;
        if (streamEnded) return;
        const source = liveClient.dispatchStream(liveGraphId, liveEventId, {
            event: (env) => {
                setEventsBySeq((prev) => {
                    if (prev.has(env.seq)) return prev;
                    const next = new Map(prev);
                    next.set(env.seq, env.payload);
                    return next;
                });
                if (env.seq > initialSeqMaxRef.current) {
                    setLiveAppended((prev) => {
                        if (prev.has(env.seq)) return prev;
                        const next = new Set(prev);
                        next.add(env.seq);
                        return next;
                    });
                }
            },
            end: () => {
                setStreamEnded(true);
                source.close();
            },
        });
        return () => {
            source.close();
        };
    }, [liveGraphId, liveEventId, liveClient, callIsRunning, streamEnded]);

    const events = useMemo<AnyEvent[]>(() => {
        const seqs = [...eventsBySeq.keys()].sort((a, b) => a - b);
        return seqs.map((s) => eventsBySeq.get(s)!);
    }, [eventsBySeq]);

    const startMs = events.length > 0 ? eventTimestampMs(events[0]!) : 0;

    const seqByEvent = useMemo(() => {
        const m = new Map<AnyEvent, number>();
        for (const [seq, ev] of eventsBySeq) m.set(ev, seq);
        return m;
    }, [eventsBySeq]);

    return (
        <div className="px-4 py-3">
            {isLive && <LiveIndicator />}
            <EventTree
                events={events}
                renderRow={(event) => {
                    const seq = seqByEvent.get(event);
                    const animate = seq !== undefined && liveAppended.has(seq);
                    if (askContext) {
                        const match = isAskAgentResult(event, events);
                        if (match && 'type' in event && event.type === 'tool.result') {
                            return (
                                <FadeIn animate={animate}>
                                    <AskRowCollapsible
                                        graphId={askContext.graphId}
                                        callerNodeId={match.callerNodeId}
                                        calleeNodeId={match.calleeNodeId}
                                        childEventId={match.childEventId}
                                        toolResult={event}
                                        treeStartMs={startMs}
                                        eventMs={eventTimestampMs(event)}
                                        client={askContext.client}
                                    />
                                </FadeIn>
                            );
                        }
                    }
                    if (animate) {
                        return (
                            <FadeIn animate={animate}>
                                <DefaultEventRow event={event} startMs={startMs} />
                            </FadeIn>
                        );
                    }
                    return null;
                }}
            />
        </div>
    );
}

function LiveIndicator() {
    return (
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            live
        </div>
    );
}

function FadeIn({ animate, children }: { animate: boolean; children: React.ReactNode }) {
    const [mounted, setMounted] = useState(!animate);
    useEffect(() => {
        if (!animate) return;
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, [animate]);
    if (!animate) return <>{children}</>;
    return (
        <div className="transition-opacity duration-200" style={{ opacity: mounted ? 1 : 0 }}>
            {children}
        </div>
    );
}

function DefaultEventRow({ event, startMs }: { event: AnyEvent; startMs: number }) {
    const ts = eventTimestampMs(event);
    const offset = formatRelativeOffsetLocal(ts - startMs);
    const type = 'type' in event ? event.type : 'dispatch';
    return (
        <details className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-700 open:bg-white dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300 dark:open:bg-zinc-950">
            <summary className="flex cursor-pointer items-center justify-between gap-2 font-mono">
                <span className="text-zinc-800 dark:text-zinc-200">{type}</span>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-500">{offset}</span>
            </summary>
            <pre className="mt-1 max-h-[28rem] overflow-auto rounded border border-zinc-200 bg-white p-2 text-[10px] leading-tight text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                {JSON.stringify(event, null, 2)}
            </pre>
        </details>
    );
}

function formatRelativeOffsetLocal(deltaMs: number): string {
    if (!Number.isFinite(deltaMs)) return '';
    if (deltaMs < 1000) return `+${Math.round(deltaMs)}ms`;
    return `+${(deltaMs / 1000).toFixed(2)}s`;
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {label}
            </span>
            <div className="flex flex-wrap items-center gap-2">{children}</div>
        </div>
    );
}

function NodeChip({ id }: { id: string }) {
    return (
        <span className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            {id}
        </span>
    );
}

function AskChainBreadcrumb({ chain }: { chain: ReadonlyArray<string> }) {
    if (chain.length === 0) {
        return <span className="text-[11px] text-zinc-400 dark:text-zinc-500">(root call)</span>;
    }
    return (
        <div className="flex flex-wrap items-center gap-1">
            {chain.map((id, i) => (
                <span key={`${id}-${i}`} className="flex items-center gap-1">
                    <NodeChip id={id} />
                    {i < chain.length - 1 && (
                        <span className="text-zinc-400 dark:text-zinc-500">→</span>
                    )}
                </span>
            ))}
        </div>
    );
}

export function StatusBadge({ status }: { status: AskCallDetail['response']['status'] }) {
    return (
        <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadgeClass(status)}`}
        >
            {status}
        </span>
    );
}
