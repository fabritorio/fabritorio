import { describe, expect, it } from 'vitest';
import type { AskCallDetail } from '@fabritorio/types';
import {
    ASK_CALL_TABS,
    eventTimestampMs,
    eventTypeLabel,
    formatDuration,
    formatRelativeOffset,
    statusBadgeClass,
} from '../lib/ask-call-detail';

function detail(overrides: Partial<AskCallDetail> = {}): AskCallDetail {
    return {
        call: {
            brief: 'help me',
            askChain: ['a', 'b'],
            inheritSession: false,
            timeoutMs: 60_000,
            calleeNodeId: 'b',
            callerNodeId: 'a',
            ...overrides.call,
        },
        response: {
            stdout: 'done',
            exitCode: 0,
            status: 'ok',
            durationMs: 1234,
            ...overrides.response,
        },
        internal: overrides.internal ?? [],
    };
}

describe('ASK_CALL_TABS', () => {
    it('exposes the three tabs in order: call, response, internal', () => {
        expect(ASK_CALL_TABS.map((t) => t.id)).toEqual(['call', 'response', 'internal']);
    });
});

describe('statusBadgeClass', () => {
    it('returns distinct class strings per status', () => {
        const ok = statusBadgeClass('ok');
        const failed = statusBadgeClass('failed');
        const running = statusBadgeClass('running');
        expect(ok).not.toBe(failed);
        expect(ok).not.toBe(running);
        expect(failed).not.toBe(running);
        expect(ok).toMatch(/emerald/);
        expect(failed).toMatch(/rose/);
        expect(running).toMatch(/sky/);
    });
});

describe('formatDuration', () => {
    it('returns "running…" for null', () => {
        expect(formatDuration(null)).toBe('running…');
    });
    it('formats < 1s in ms, >= 1s in s with 2dp', () => {
        expect(formatDuration(0)).toBe('0ms');
        expect(formatDuration(750)).toBe('750ms');
        expect(formatDuration(1500)).toBe('1.50s');
        expect(formatDuration(10_500)).toBe('10.50s');
    });
});

describe('eventTimestampMs', () => {
    it('reads `timestamp` from a DispatchEvent', () => {
        expect(
            eventTimestampMs({
                eventId: 'e1',
                source: 'x',
                timestamp: 1234,
                messages: [],
            }),
        ).toBe(1234);
    });

    it('parses `ts` ISO string for ObservabilityEvents', () => {
        expect(
            eventTimestampMs({
                type: 'llm.chunk',
                ts: new Date(5000).toISOString(),
                eventId: 'e1',
                node_id: 'n',
                delta: 'hi',
            }),
        ).toBe(5000);
    });
});

describe('eventTypeLabel', () => {
    it('returns the `type` for an observability event', () => {
        expect(
            eventTypeLabel({
                type: 'output.emitted',
                ts: new Date().toISOString(),
                eventId: 'e',
                node_id: 'n',
                port: 'result',
                messages: [],
            }),
        ).toBe('output.emitted');
    });

    it('returns "dispatch" for DispatchEvent (no `type` field)', () => {
        expect(
            eventTypeLabel({
                eventId: 'e',
                source: 's',
                timestamp: 0,
                messages: [],
            }),
        ).toBe('dispatch');
    });
});

describe('formatRelativeOffset', () => {
    it('signs and rounds', () => {
        expect(formatRelativeOffset(0)).toBe('+0ms');
        expect(formatRelativeOffset(123)).toBe('+123ms');
        expect(formatRelativeOffset(-456)).toBe('-456ms');
        expect(formatRelativeOffset(123.7)).toBe('+124ms');
    });
});

describe('AskCallDetail payload shape', () => {
    it('preserves caller/callee identity through the type', () => {
        const d = detail();
        expect(d.call.callerNodeId).toBe('a');
        expect(d.call.calleeNodeId).toBe('b');
    });

    it('failed responses surface exitCode 1', () => {
        const d = detail({
            response: { stdout: 'boom', exitCode: 1, status: 'failed', durationMs: 5 },
        });
        expect(d.response.status).toBe('failed');
        expect(d.response.exitCode).toBe(1);
    });

    it('running responses surface null durationMs', () => {
        const d = detail({
            response: { stdout: '', exitCode: 0, status: 'running', durationMs: null },
        });
        expect(d.response.durationMs).toBeNull();
        expect(formatDuration(d.response.durationMs)).toBe('running…');
    });
});
