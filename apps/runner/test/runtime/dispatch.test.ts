import { describe, it, expect } from 'vitest';
import type { DispatchEvent, Message } from '@fabritorio/types';
import { childDispatch, newDispatch } from '../../src/runtime/dispatch.js';

const MESSAGES: Message[] = [{ role: 'user', content: 'hi' }];
const FIXED_NOW = () => 1234;

function makeParent(meta?: Record<string, unknown>): DispatchEvent {
    return newDispatch({
        source: 'channel:c1',
        messages: MESSAGES,
        ...(meta ? { meta } : {}),
        now: FIXED_NOW,
    });
}

describe('childDispatch', () => {
    it('chains parentId and inherits parent meta when args has no meta', () => {
        const parent = makeParent({ port: 'result', traceId: 'abc' });
        const child = childDispatch(parent, {
            source: 'agent:a1',
            messages: MESSAGES,
            now: FIXED_NOW,
        });
        expect(child.parentId).toBe(parent.eventId);
        expect(child.meta).toEqual({ port: 'result', traceId: 'abc' });
    });

    it('merges parent meta with args meta; args wins on key collision', () => {
        const parent = makeParent({ port: 'result', traceId: 'abc' });
        const child = childDispatch(parent, {
            source: 'agent:a1',
            messages: MESSAGES,
            meta: { port: 'error', extra: 1 },
            now: FIXED_NOW,
        });
        expect(child.meta).toEqual({ port: 'error', traceId: 'abc', extra: 1 });
    });

    it('uses args meta when parent has no meta', () => {
        const parent = makeParent();
        const child = childDispatch(parent, {
            source: 'agent:a1',
            messages: MESSAGES,
            meta: { port: 'result' },
            now: FIXED_NOW,
        });
        expect(child.meta).toEqual({ port: 'result' });
    });

    it('omits meta entirely when neither parent nor args has meta', () => {
        const parent = makeParent();
        const child = childDispatch(parent, {
            source: 'agent:a1',
            messages: MESSAGES,
            now: FIXED_NOW,
        });
        expect('meta' in child).toBe(false);
    });

    it('inherits parent.source when args.source is omitted', () => {
        const parent = makeParent();
        const child = childDispatch(parent, {
            messages: MESSAGES,
            now: FIXED_NOW,
        });
        expect(child.source).toBe(parent.source);
        expect(child.parentId).toBe(parent.eventId);
    });

    it('uses explicit args.source when provided (new-session opt-in)', () => {
        const parent = makeParent();
        const child = childDispatch(parent, {
            source: 'ask:a->b:eventX',
            messages: MESSAGES,
            now: FIXED_NOW,
        });
        expect(child.source).toBe('ask:a->b:eventX');
    });
});
