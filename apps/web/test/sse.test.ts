import { describe, expect, it } from 'vitest';
import { parseObservabilityEvent, parseSseFrame, splitSseStream } from '../lib/sse';

describe('parseSseFrame', () => {
    it('extracts event and data', () => {
        const frame = 'event: llm.request\ndata: {"hello":"world"}';
        const out = parseSseFrame(frame);
        expect(out).toEqual({ event: 'llm.request', data: '{"hello":"world"}' });
    });

    it('joins multi-line data with newlines', () => {
        const frame = 'event: llm.chunk\ndata: line1\ndata: line2';
        const out = parseSseFrame(frame);
        expect(out?.data).toBe('line1\nline2');
    });

    it('ignores comment lines', () => {
        const frame = ': heartbeat\nevent: output.emitted\ndata: {}';
        const out = parseSseFrame(frame);
        expect(out?.event).toBe('output.emitted');
        expect(out?.data).toBe('{}');
    });

    it('handles a leading space after the colon', () => {
        const frame = 'event: output.emitted\ndata:{"ok":true}';
        const out = parseSseFrame(frame);
        expect(out?.data).toBe('{"ok":true}');
    });

    it('returns null when there is no data line', () => {
        expect(parseSseFrame('event: ping')).toBeNull();
    });
});

describe('splitSseStream', () => {
    it('splits on double LF', () => {
        const buffer = 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3';
        const { frames, rest } = splitSseStream(buffer);
        expect(frames).toEqual(['event: a\ndata: 1', 'event: b\ndata: 2']);
        expect(rest).toBe('event: c\ndata: 3');
    });

    it('handles CRLF separators', () => {
        const buffer = 'event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n';
        const { frames, rest } = splitSseStream(buffer);
        expect(frames).toEqual(['event: a\r\ndata: 1', 'event: b\r\ndata: 2']);
        expect(rest).toBe('');
    });

    it('returns empty frames when no boundary yet', () => {
        const { frames, rest } = splitSseStream('event: incomplete');
        expect(frames).toEqual([]);
        expect(rest).toBe('event: incomplete');
    });
});

describe('parseObservabilityEvent', () => {
    it('parses an output.emitted frame', () => {
        const frame =
            'event: output.emitted\ndata: {"type":"output.emitted","ts":"2026-04-22T00:00:00.000Z","eventId":"d","node_id":"o","port":"result","messages":[]}';
        const parsed = parseObservabilityEvent(frame);
        expect(parsed?.type).toBe('output.emitted');
    });

    it('returns null on bad JSON', () => {
        const frame = 'event: llm.chunk\ndata: not-json';
        expect(parseObservabilityEvent(frame)).toBeNull();
    });
});
