import { describe, expect, it } from 'vitest';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import {
    buildDispatchGroups,
    categoryOfSource,
    filterGroups,
    isDispatchEvent,
    labelForRow,
    summarizeDispatch,
    summarizeEvent,
    type LogEntry,
} from '../lib/event-rows';

const baseObs = {
    ts: '2026-04-22T00:00:00.000Z',
    eventId: 'root-1',
    parentId: 'root-1',
    node_id: 'm1',
};

const obs = (
    ev: Partial<ObservabilityEvent> & { type: ObservabilityEvent['type'] },
): ObservabilityEvent =>
    ({
        ...baseObs,
        ...ev,
    }) as ObservabilityEvent;

const dispatch = (
    overrides: Partial<DispatchEvent> & { eventId: string; source: string },
): DispatchEvent => ({
    timestamp: Date.parse('2026-04-22T00:00:00.000Z'),
    messages: [],
    ...overrides,
});

describe('buildDispatchGroups', () => {
    it('groups observability events under their root Dispatch by eventId', () => {
        const events: LogEntry[] = [
            dispatch({ eventId: 'root-1', source: 'webchat:c1' }),
            obs({ type: 'llm.request', model: 'x', messages: [] }),
            obs({
                type: 'output.emitted',
                ts: '2026-04-22T00:00:01.000Z',
                port: 'result',
                port_id: 'result',
                messages: [{ role: 'assistant', content: 'ok' }],
            }),
        ];
        const groups = buildDispatchGroups(events);
        expect(groups).toHaveLength(1);
        const g = groups[0]!;
        expect(g.root.eventId).toBe('root-1');
        expect(g.category).toBe('channel');
        expect(g.rows).toHaveLength(2);
        expect(g.rows[0]!.kind).toBe('event');
        expect(g.rows.every((r) => r.depth === 1)).toBe(true);
    });

    it('emits one group per root Dispatch and orders rows chronologically', () => {
        const events: LogEntry[] = [
            dispatch({
                eventId: 'root-2',
                source: 'webchat:c1',
                timestamp: Date.parse('2026-04-22T00:00:05.000Z'),
            }),
            dispatch({
                eventId: 'root-1',
                source: 'webchat:c1',
                timestamp: Date.parse('2026-04-22T00:00:01.000Z'),
            }),
            obs({
                type: 'llm.response',
                eventId: 'root-1',
                parentId: 'root-1',
                ts: '2026-04-22T00:00:03.000Z',
                content: 'hi',
                finish_reason: 'stop',
            }),
            obs({
                type: 'llm.request',
                eventId: 'root-1',
                parentId: 'root-1',
                ts: '2026-04-22T00:00:02.000Z',
                model: 'x',
                messages: [],
            }),
        ];
        const groups = buildDispatchGroups(events);
        expect(groups).toHaveLength(2);
        expect(groups.map((g) => g.root.eventId)).toEqual(['root-2', 'root-1']);
        const root1 = groups.find((g) => g.root.eventId === 'root-1')!;
        expect(root1.rows.map((r) => (r.kind === 'event' ? r.ev.type : r.kind))).toEqual([
            'llm.request',
            'llm.response',
        ]);
    });

    it("nests reply Dispatches under their parent's group at depth 1", () => {
        const events: LogEntry[] = [
            dispatch({ eventId: 'root-1', source: 'webchat:c1' }),
            dispatch({
                eventId: 'reply-1',
                parentId: 'root-1',
                source: 'agent:a1',
                timestamp: Date.parse('2026-04-22T00:00:02.000Z'),
                messages: [{ role: 'assistant', content: 'hi' }],
            }),
        ];
        const groups = buildDispatchGroups(events);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.rows).toHaveLength(1);
        const replyRow = groups[0]!.rows[0]!;
        expect(replyRow.kind).toBe('dispatch');
        if (replyRow.kind !== 'dispatch') throw new Error('expected dispatch row');
        expect(replyRow.isRoot).toBe(false);
        expect(replyRow.ev.source).toBe('agent:a1');
        expect(replyRow.depth).toBe(1);
    });

    it('collapses consecutive llm.chunk frames within a group', () => {
        const chunk = (delta: string, kind?: 'content' | 'reasoning') =>
            obs({
                type: 'llm.chunk',
                ts: '2026-04-22T00:00:01.000Z',
                delta,
                ...(kind ? { kind } : {}),
            } as ObservabilityEvent);
        const events: LogEntry[] = [
            dispatch({ eventId: 'root-1', source: 'webchat:c1' }),
            chunk('Hel'),
            chunk('lo'),
            chunk(' world'),
        ];
        const groups = buildDispatchGroups(events);
        expect(groups[0]!.rows).toHaveLength(1);
        const row = groups[0]!.rows[0]!;
        expect(row.kind).toBe('chunk-group');
        if (row.kind !== 'chunk-group') throw new Error('expected group');
        expect(row.count).toBe(3);
        expect(row.accumulated).toBe('Hello world');
        expect(row.stream_kind).toBe('content');
    });

    it('splits reasoning and content chunks into separate groups', () => {
        const reasoning = obs({
            type: 'llm.chunk',
            ts: '2026-04-22T00:00:01.000Z',
            delta: 'thinking…',
            kind: 'reasoning',
        } as ObservabilityEvent);
        const content = obs({
            type: 'llm.chunk',
            ts: '2026-04-22T00:00:02.000Z',
            delta: 'Hello',
        } as ObservabilityEvent);
        const events: LogEntry[] = [
            dispatch({ eventId: 'root-1', source: 'webchat:c1' }),
            reasoning,
            content,
        ];
        const groups = buildDispatchGroups(events);
        expect(groups[0]!.rows.map((r) => r.kind)).toEqual(['chunk-group', 'chunk-group']);
    });

    it('drops orphan observability events with no matching root', () => {
        const events: LogEntry[] = [obs({ type: 'llm.request', model: 'x', messages: [] })];
        const groups = buildDispatchGroups(events);
        expect(groups).toHaveLength(0);
    });
});

describe('categoryOfSource', () => {
    it('classifies webchat: as channel', () => {
        expect(categoryOfSource('webchat:c1')).toBe('channel');
    });
    it('classifies channel: as channel', () => {
        expect(categoryOfSource('channel:slack')).toBe('channel');
    });
    it('classifies trigger: as trigger', () => {
        expect(categoryOfSource('trigger:cron-1')).toBe('trigger');
    });
    it('classifies agent: as agent', () => {
        expect(categoryOfSource('agent:a1')).toBe('agent');
    });
    it('falls back to agent for unrecognised sources', () => {
        expect(categoryOfSource('foo:bar')).toBe('agent');
    });
});

describe('filterGroups', () => {
    const groups = buildDispatchGroups([
        dispatch({ eventId: 'ch', source: 'webchat:c1' }),
        dispatch({ eventId: 'tr', source: 'trigger:cron-1' }),
        dispatch({ eventId: 'ag', source: 'agent:a1' }),
    ]);

    it("returns all groups for 'all'", () => {
        expect(filterGroups(groups, 'all')).toHaveLength(3);
    });

    it('filters by channel', () => {
        const filtered = filterGroups(groups, 'channel');
        expect(filtered.map((g) => g.root.eventId)).toEqual(['ch']);
    });

    it('filters by trigger', () => {
        const filtered = filterGroups(groups, 'trigger');
        expect(filtered.map((g) => g.root.eventId)).toEqual(['tr']);
    });

    it('filters by agent', () => {
        const filtered = filterGroups(groups, 'agent');
        expect(filtered.map((g) => g.root.eventId)).toEqual(['ag']);
    });
});

describe('labelForRow', () => {
    it('synthesises dispatch.<category> for root rows', () => {
        const groups = buildDispatchGroups([
            dispatch({ eventId: 'root-1', source: 'webchat:c1' }),
            dispatch({
                eventId: 'reply-1',
                parentId: 'root-1',
                source: 'agent:a1',
            }),
        ]);
        const replyRow = groups[0]!.rows[0]!;
        expect(labelForRow(replyRow)).toBe('dispatch.reply');
    });

    it('uses the original type for observability rows', () => {
        const groups = buildDispatchGroups([
            dispatch({ eventId: 'root-1', source: 'webchat:c1' }),
            obs({ type: 'llm.request', model: 'x', messages: [] }),
        ]);
        expect(labelForRow(groups[0]!.rows[0]!)).toBe('llm.request');
    });

    it('annotates chunk-group rows with stream kind and count', () => {
        const groups = buildDispatchGroups([
            dispatch({ eventId: 'root-1', source: 'webchat:c1' }),
            obs({
                type: 'llm.chunk',
                delta: 'a',
            } as ObservabilityEvent),
            obs({
                type: 'llm.chunk',
                delta: 'b',
            } as ObservabilityEvent),
        ]);
        expect(labelForRow(groups[0]!.rows[0]!)).toBe('llm.chunk×2');
    });
});

describe('summarizeDispatch', () => {
    it('includes the source and the user message head', () => {
        const ev = dispatch({
            eventId: 'r',
            source: 'webchat:c1',
            messages: [{ role: 'user', content: 'hello there' }],
        });
        expect(summarizeDispatch(ev)).toBe('webchat:c1 — hello there');
    });

    it('falls back to the assistant message for replies', () => {
        const ev = dispatch({
            eventId: 'r',
            parentId: 'p',
            source: 'agent:a1',
            messages: [{ role: 'assistant', content: 'hi' }],
        });
        expect(summarizeDispatch(ev)).toBe('agent:a1 — hi');
    });

    it('omits the dash when there is no message content', () => {
        const ev = dispatch({ eventId: 'r', source: 'trigger:cron-1' });
        expect(summarizeDispatch(ev)).toBe('trigger:cron-1');
    });
});

describe('summarizeEvent (regression)', () => {
    it('llm.request shows model and message count', () => {
        expect(
            summarizeEvent(
                obs({
                    type: 'llm.request',
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'user', content: 'hi' },
                        { role: 'system', content: 'x' },
                    ],
                }),
            ),
        ).toBe('gpt-4o-mini · 2 msgs');
    });

    it('tool.result distinguishes success and failure', () => {
        expect(
            summarizeEvent(
                obs({
                    type: 'tool.result',
                    call_id: 'c1',
                    stdout: 'hello',
                    stderr: '',
                    exit_code: 0,
                }),
            ),
        ).toBe('exit=0 · hello');
    });

    it('model_router.fell_through renders compact "from → to (reason)"', () => {
        expect(
            summarizeEvent({
                ts: '2026-05-14T00:00:00Z',
                eventId: 'evt-1',
                node_id: 'router-1',
                type: 'model_router.fell_through',
                from_model_node_id: 'm-a',
                from_model_id: 'gpt-4o-mini',
                to_model_node_id: 'm-b',
                to_model_id: 'llama-3.1-8b',
                reason: '429 Too Many Requests',
            }),
        ).toBe('gpt-4o-mini → llama-3.1-8b (429 Too Many Requests)');
    });
});

describe('isDispatchEvent', () => {
    it('returns true for DispatchEvent shape', () => {
        expect(isDispatchEvent(dispatch({ eventId: 'r', source: 'webchat:c1' }))).toBe(true);
    });
    it('returns false for ObservabilityEvent shape', () => {
        expect(isDispatchEvent(obs({ type: 'llm.request', model: 'x', messages: [] }))).toBe(false);
    });
});
