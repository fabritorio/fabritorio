import type { AskCallDetail, DispatchEvent, ObservabilityEvent } from '@fabritorio/types';

export type AskCallTab = 'call' | 'response' | 'internal';

export const ASK_CALL_TABS: ReadonlyArray<{ id: AskCallTab; label: string }> = [
    { id: 'call', label: 'Call' },
    { id: 'response', label: 'Response' },
    { id: 'internal', label: 'Internal work' },
];

export function statusBadgeClass(status: AskCallDetail['response']['status']): string {
    switch (status) {
        case 'ok':
            return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200';
        case 'failed':
            return 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200';
        case 'running':
            return 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200';
        default:
            return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
    }
}

export function formatDuration(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) return 'running…';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

export type InternalEvent = DispatchEvent | ObservabilityEvent;

export function eventTimestampMs(event: InternalEvent): number {
    if ('type' in event) return Date.parse(event.ts);
    return event.timestamp;
}

export function eventTypeLabel(event: InternalEvent): string {
    if ('type' in event) return event.type;
    return 'dispatch';
}

export function formatRelativeOffset(deltaMs: number): string {
    if (!Number.isFinite(deltaMs)) return '';
    const sign = deltaMs < 0 ? '-' : '+';
    return `${sign}${Math.abs(Math.round(deltaMs))}ms`;
}
