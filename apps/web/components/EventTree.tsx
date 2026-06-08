'use client';

import type { ReactNode } from 'react';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import {
    eventTimestampMs,
    eventTypeLabel,
    formatRelativeOffset,
    type InternalEvent,
} from '@/lib/ask-call-detail';

type Event = DispatchEvent | ObservabilityEvent;

interface Props {
    events: ReadonlyArray<Event>;
    renderRow?: (event: Event, index: number) => ReactNode | null;
}

export function EventTree({ events, renderRow }: Props) {
    if (events.length === 0) {
        return (
            <div className="text-[11px] text-zinc-400 dark:text-zinc-500">(no recorded events)</div>
        );
    }
    const start = eventTimestampMs(events[0]!);
    return (
        <div className="space-y-1">
            {events.map((ev, i) => {
                const custom = renderRow?.(ev, i);
                if (custom != null) {
                    return <div key={i}>{custom}</div>;
                }
                return <DefaultRow key={i} event={ev} start={start} />;
            })}
        </div>
    );
}

function DefaultRow({ event, start }: { event: InternalEvent; start: number }) {
    const ts = eventTimestampMs(event);
    const offset = formatRelativeOffset(ts - start);
    const type = eventTypeLabel(event);
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
