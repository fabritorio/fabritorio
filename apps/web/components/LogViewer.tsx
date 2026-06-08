'use client';

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import type {
    DispatchStreamEvent,
    ObservabilityReplayResult,
    RunnerClient,
    StreamSubscription,
} from '@/lib/runner-client';
import { useFabritorioStore } from '@/lib/store';
import { publishLiveEvent } from '@/lib/live-bus';
import { SentinelGate } from '@/lib/sentinel-gate';
import {
    buildDispatchGroups,
    categoryOfSource,
    filterGroups,
    isDispatchEvent,
    labelForRow,
    summarizeDispatch,
    summarizeEvent,
    type DispatchGroup,
    type EventRow,
    type SourceCategory,
} from '@/lib/event-rows';

const CATEGORIES: Array<{ key: SourceCategory; label: string }> = [
    { key: 'all', label: 'all' },
    { key: 'channel', label: 'channel' },
    { key: 'trigger', label: 'trigger' },
    { key: 'agent', label: 'agent' },
];

type FlushScheduler = (flush: () => void) => void;

const defaultScheduleFlush: FlushScheduler = (flush) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flush());
    else setTimeout(flush, 0);
};

let activeObservabilitySource: StreamSubscription | null = null;

export function subscribeObservabilityStream(deps: {
    client: RunnerClient;
    appendEvents: (evs: ReadonlyArray<DispatchEvent | ObservabilityEvent>) => void;
    clearEvents: () => void;
    scheduleFlush?: FlushScheduler;
    publish?: (e: ObservabilityEvent) => void;
}): () => void {
    activeObservabilitySource?.close();
    activeObservabilitySource = null;
    deps.clearEvents();
    const scheduleFlush = deps.scheduleFlush ?? defaultScheduleFlush;
    const publish = deps.publish ?? publishLiveEvent;
    const gate = new SentinelGate();
    const seen = new Set<number>();
    let closed = false;
    let armed = false;
    let liveBuffer: DispatchStreamEvent[] = [];
    let buffer: Array<DispatchEvent | ObservabilityEvent> = [];
    let pending = false;
    const flush = () => {
        pending = false;
        if (closed || buffer.length === 0) return;
        const batch = buffer;
        buffer = [];
        deps.appendEvents(batch);
    };

    const handleFrame = (env: DispatchStreamEvent) => {
        if (closed) return;
        if (seen.has(env.seq)) return;
        seen.add(env.seq);
        buffer.push(env.payload);
        if (!pending) {
            pending = true;
            scheduleFlush(flush);
        }
        if (env.kind === 'observability' && gate.shouldPublish(env.seq)) {
            publish(env.payload as ObservabilityEvent);
        }
    };

    const source = deps.client.observabilityStream({
        event(env) {
            if (closed) return;
            if (!armed) {
                liveBuffer.push(env);
                return;
            }
            handleFrame(env);
        },
    });
    activeObservabilitySource = source;

    void (async () => {
        let replay: ObservabilityReplayResult;
        try {
            replay = await deps.client.observabilityReplay({ tail: 500 });
        } catch {
            replay = { events: [], max: -1 };
        }
        if (closed) return;
        const payloads: Array<DispatchEvent | ObservabilityEvent> = [];
        for (const e of replay.events) {
            if (seen.has(e.seq)) continue;
            seen.add(e.seq);
            payloads.push(e.payload);
        }
        if (payloads.length > 0) deps.appendEvents(payloads);
        gate.markSnapshotComplete(replay.max);
        armed = true;
        const buffered = liveBuffer;
        liveBuffer = [];
        for (const env of buffered) handleFrame(env);
    })();

    return () => {
        closed = true;
        source.close();
        if (activeObservabilitySource === source) activeObservabilitySource = null;
        buffer = [];
        liveBuffer = [];
        deps.clearEvents();
    };
}

export const subscribeLogViewerStream = subscribeObservabilityStream;

export function LogViewer() {
    const events = useFabritorioStore((s) => s.events);
    const [category, setCategory] = useState<SourceCategory>('all');
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
    const containerRef = useRef<HTMLDivElement>(null);

    const groups = useMemo(() => buildDispatchGroups(events), [events]);
    const visibleGroups = useMemo(() => filterGroups(groups, category), [groups, category]);

    useEffect(() => {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [visibleGroups]);

    const toggleGroup = useCallback((rootId: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(rootId)) next.delete(rootId);
            else next.add(rootId);
            return next;
        });
    }, []);

    const toggleRow = useCallback((idx: number) => {
        setExpandedRows((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
    }, []);

    return (
        <div className="flex h-full flex-col border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                <div className="flex items-center gap-2">
                    <span>Event log</span>
                    <div className="flex items-center gap-1">
                        {CATEGORIES.map((c) => (
                            <button
                                key={c.key}
                                type="button"
                                onClick={() => setCategory(c.key)}
                                className={`rounded px-2 py-0.5 text-[10px] transition ${
                                    category === c.key
                                        ? 'bg-indigo-500 text-white'
                                        : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                                }`}
                            >
                                {c.label}
                            </button>
                        ))}
                    </div>
                </div>
                <span>
                    {visibleGroups.length} / {groups.length} dispatches · {events.length} events
                </span>
            </div>
            <div
                ref={containerRef}
                className="flex-1 overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300"
            >
                {visibleGroups.length === 0 ? (
                    <div className="text-zinc-400 dark:text-zinc-600">
                        (no events yet — send a message in the chat panel)
                    </div>
                ) : (
                    visibleGroups.map((g) => (
                        <GroupView
                            key={g.root.eventId}
                            group={g}
                            collapsed={collapsed.has(g.root.eventId)}
                            onToggleGroup={() => toggleGroup(g.root.eventId)}
                            expandedRows={expandedRows}
                            onToggleRow={toggleRow}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

function GroupView({
    group,
    collapsed,
    onToggleGroup,
    expandedRows,
    onToggleRow,
}: {
    group: DispatchGroup;
    collapsed: boolean;
    onToggleGroup: () => void;
    expandedRows: Set<number>;
    onToggleRow: (idx: number) => void;
}) {
    const ts = new Date(group.root.timestamp).toISOString().slice(11, 19);
    const summary = summarizeDispatch(group.root);
    return (
        <div className="mt-1 first:mt-0">
            <button
                type="button"
                onClick={onToggleGroup}
                className="grid w-full grid-cols-[12px_80px_140px_1fr] items-baseline gap-2 rounded border-l-2 border-indigo-300 bg-indigo-50/40 px-1 py-0.5 text-left hover:bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/30 dark:hover:bg-indigo-950/60"
            >
                <span className="text-zinc-400 dark:text-zinc-600">{collapsed ? '▸' : '▾'}</span>
                <span className="text-zinc-500 dark:text-zinc-500">{ts}</span>
                <span className="text-indigo-700 dark:text-indigo-300">
                    dispatch.{group.category}
                </span>
                <span className="truncate text-zinc-700 dark:text-zinc-200">{summary}</span>
            </button>
            {!collapsed && group.rows.length > 0 && (
                <div className="border-l border-zinc-200 dark:border-zinc-800">
                    {group.rows.map((row) => (
                        <RowView
                            key={row.index}
                            row={row}
                            expanded={expandedRows.has(row.index)}
                            onToggle={() => onToggleRow(row.index)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function RowView({
    row,
    expanded,
    onToggle,
}: {
    row: EventRow;
    expanded: boolean;
    onToggle: () => void;
}) {
    const indent = `${row.depth * 16}px`;
    const isReasoning = row.kind === 'chunk-group' && row.stream_kind === 'reasoning';
    const ts =
        row.kind === 'chunk-group'
            ? row.first.ts
            : row.kind === 'dispatch'
              ? new Date(row.ev.timestamp).toISOString()
              : row.ev.ts;
    const nodeId =
        row.kind === 'chunk-group'
            ? row.first.node_id
            : row.kind === 'dispatch'
              ? row.ev.source
              : row.ev.node_id;
    const portId =
        row.kind === 'chunk-group'
            ? row.first.port_id
            : row.kind === 'event'
              ? row.ev.port_id
              : undefined;
    const typeLabel = labelForRow(row);
    const detail =
        row.kind === 'chunk-group'
            ? truncate(row.accumulated, 320)
            : row.kind === 'dispatch'
              ? summarizeDispatch(row.ev)
              : summarizeEvent(row.ev);

    return (
        <div style={{ paddingLeft: indent }}>
            <button
                type="button"
                onClick={onToggle}
                className="grid w-full grid-cols-[12px_80px_140px_150px_1fr] items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
                <span className="text-zinc-400 dark:text-zinc-600">{expanded ? '▾' : '▸'}</span>
                <span className="text-zinc-400 dark:text-zinc-500">{ts.slice(11, 19)}</span>
                <span className={colorFor(typeLabel)}>{typeLabel}</span>
                <span className="truncate text-zinc-500 dark:text-zinc-400">
                    <span>{nodeId}</span>
                    {portId && (
                        <span className="ml-1 text-zinc-400 dark:text-zinc-600">·{portId}</span>
                    )}
                </span>
                <span
                    className={`truncate whitespace-pre ${
                        isReasoning
                            ? 'italic text-zinc-500 dark:text-zinc-500'
                            : 'text-zinc-800 dark:text-zinc-200'
                    }`}
                >
                    {detail}
                </span>
            </button>
            {expanded && (
                <pre
                    className="mt-1 mb-2 max-h-[28rem] overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-[10px] leading-tight text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                    style={{ marginLeft: '120px' }}
                >
                    {row.kind === 'chunk-group'
                        ? row.accumulated
                        : row.kind === 'dispatch'
                          ? prettyDispatch(row.ev)
                          : prettyObservability(row.ev)}
                </pre>
            )}
        </div>
    );
}

function prettyObservability(ev: ObservabilityEvent): string {
    const { ts, eventId, parentId, node_id, port_id, ...rest } = ev as unknown as Record<
        string,
        unknown
    >;
    void ts;
    void eventId;
    void parentId;
    void node_id;
    void port_id;
    return JSON.stringify(rest, null, 2);
}

function prettyDispatch(ev: DispatchEvent): string {
    const { eventId, parentId, source, timestamp, ...rest } = ev as unknown as Record<
        string,
        unknown
    >;
    void eventId;
    void parentId;
    void source;
    void timestamp;
    return JSON.stringify(rest, null, 2);
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function colorFor(type: string): string {
    if (type.startsWith('dispatch.')) return 'text-indigo-700 dark:text-indigo-300';
    if (type.startsWith('llm.thinking')) return 'text-violet-500 dark:text-violet-400';
    if (type.startsWith('llm.')) return 'text-indigo-600 dark:text-indigo-300';
    if (type.startsWith('gateway.') || type.startsWith('output.'))
        return 'text-emerald-600 dark:text-emerald-300';
    if (type.startsWith('tool.')) return 'text-rose-600 dark:text-rose-300';
    if (type.startsWith('workspace.')) return 'text-amber-700 dark:text-amber-400';
    if (type.startsWith('chain.')) return 'text-rose-700 dark:text-rose-400';
    return 'text-zinc-500 dark:text-zinc-400';
}

export { categoryOfSource, isDispatchEvent };
