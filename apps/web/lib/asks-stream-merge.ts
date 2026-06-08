import type { AskCallSummary } from '@fabritorio/types';
import type { AskCompletedEvent, AskStartedEvent } from './runner-client';

export function applyStartedEvent(
    rows: AskCallSummary[],
    ev: AskStartedEvent,
    filterCallerNodeId: string,
): AskCallSummary[] {
    if (ev.callerNodeId !== filterCallerNodeId) return rows;
    if (rows.some((r) => r.eventId === ev.eventId)) return rows;
    const inserted: AskCallSummary = {
        eventId: ev.eventId,
        askCallId: ev.askCallId,
        calleeNodeId: ev.calleeNodeId,
        status: 'running',
        startedAt: ev.startedAt,
        durationMs: null,
        briefSnippet: ev.brief,
        resultSnippet: null,
    };
    return [inserted, ...rows];
}

export function applyCompletedEvent(
    rows: AskCallSummary[],
    ev: AskCompletedEvent,
): AskCallSummary[] {
    const idx = rows.findIndex((r) => r.eventId === ev.eventId);
    if (idx < 0) return rows;
    const prev = rows[idx]!;
    const next: AskCallSummary = {
        ...prev,
        status: ev.status,
        durationMs: ev.durationMs,
        resultSnippet: ev.resultSnippet,
    };
    const out = rows.slice();
    out[idx] = next;
    return out;
}
