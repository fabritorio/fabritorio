import { describe, expect, it } from 'vitest';
import type { AskCallSummary } from '@fabritorio/types';
import type { AskCompletedEvent, AskStartedEvent } from '../lib/runner-client';
import { applyCompletedEvent, applyStartedEvent } from '../lib/asks-stream-merge';

function row(eventId: string, overrides: Partial<AskCallSummary> = {}): AskCallSummary {
    return {
        eventId,
        askCallId: `ask-${eventId}`,
        calleeNodeId: 'callee',
        status: 'ok',
        startedAt: 1000,
        durationMs: 200,
        briefSnippet: `brief-${eventId}`,
        resultSnippet: `result-${eventId}`,
        ...overrides,
    };
}

function started(
    eventId: string,
    callerNodeId = 'caller',
    overrides: Partial<AskStartedEvent> = {},
): AskStartedEvent {
    return {
        eventId,
        askCallId: `ask-${eventId}`,
        callerNodeId,
        calleeNodeId: 'callee',
        brief: `brief-${eventId}`,
        startedAt: 5000,
        ...overrides,
    };
}

function completed(eventId: string, overrides: Partial<AskCompletedEvent> = {}): AskCompletedEvent {
    return {
        eventId,
        askCallId: `ask-${eventId}`,
        status: 'ok',
        durationMs: 800,
        resultSnippet: `result-${eventId}`,
        ...overrides,
    };
}

describe('applyStartedEvent', () => {
    it('inserts a started event at the head as a running row', () => {
        const rows = [row('old')];
        const next = applyStartedEvent(rows, started('new'), 'caller');
        expect(next).toHaveLength(2);
        expect(next[0]!.eventId).toBe('new');
        expect(next[0]!.status).toBe('running');
        expect(next[0]!.durationMs).toBeNull();
        expect(next[0]!.resultSnippet).toBeNull();
        expect(next[0]!.briefSnippet).toBe('brief-new');
        expect(next[1]!.eventId).toBe('old');
    });

    it('ignores started events for a different callerNodeId', () => {
        const rows = [row('existing')];
        const next = applyStartedEvent(rows, started('new', 'other-caller'), 'caller');
        expect(next).toBe(rows);
    });

    it('does not duplicate an event already present (seed-on-subscribe replay)', () => {
        const rows = [row('e1', { status: 'running', durationMs: null, resultSnippet: null })];
        const next = applyStartedEvent(rows, started('e1'), 'caller');
        expect(next).toBe(rows);
    });
});

describe('applyCompletedEvent', () => {
    it("updates the matching row's status, durationMs, and resultSnippet", () => {
        const rows = [
            row('keep'),
            row('target', { status: 'running', durationMs: null, resultSnippet: null }),
        ];
        const next = applyCompletedEvent(rows, completed('target', { durationMs: 1234 }));
        expect(next).toHaveLength(2);
        expect(next[0]!.eventId).toBe('keep');
        expect(next[0]).toBe(rows[0]);
        expect(next[1]!.eventId).toBe('target');
        expect(next[1]!.status).toBe('ok');
        expect(next[1]!.durationMs).toBe(1234);
        expect(next[1]!.resultSnippet).toBe('result-target');
    });

    it('preserves the started-side fields the completed event does not carry', () => {
        const rows = [
            row('e1', {
                status: 'running',
                durationMs: null,
                resultSnippet: null,
                briefSnippet: 'preserve-me',
                startedAt: 7777,
                calleeNodeId: 'special-callee',
            }),
        ];
        const next = applyCompletedEvent(rows, completed('e1'));
        expect(next[0]!.briefSnippet).toBe('preserve-me');
        expect(next[0]!.startedAt).toBe(7777);
        expect(next[0]!.calleeNodeId).toBe('special-callee');
    });

    it('ignores completed events for unknown eventIds (no phantom row)', () => {
        const rows = [row('e1')];
        const next = applyCompletedEvent(rows, completed('ghost'));
        expect(next).toBe(rows);
    });

    it('marks status as failed when the completion port is error', () => {
        const rows = [row('e1', { status: 'running', durationMs: null, resultSnippet: null })];
        const next = applyCompletedEvent(rows, completed('e1', { status: 'failed' }));
        expect(next[0]!.status).toBe('failed');
    });
});
