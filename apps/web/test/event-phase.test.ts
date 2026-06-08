import { describe, expect, it } from 'vitest';
import type { ObservabilityEvent } from '@fabritorio/types';
import { phaseOf } from '../lib/event-phase';

function ev<T extends ObservabilityEvent['type']>(
    type: T,
    extra: Partial<ObservabilityEvent> & Record<string, unknown> = {},
): ObservabilityEvent {
    return {
        type,
        ts: '2026-05-29T00:00:00.000Z',
        eventId: 'd-1',
        node_id: 'n',
        ...extra,
    } as ObservabilityEvent;
}

describe('phaseOf', () => {
    it('maps llm.chunk{reasoning} → thinking…', () => {
        expect(phaseOf(ev('llm.chunk', { kind: 'reasoning', delta: 'x' }))).toBe('thinking…');
    });

    it('maps llm.chunk{content} → responding…', () => {
        expect(phaseOf(ev('llm.chunk', { kind: 'content', delta: 'x' }))).toBe('responding…');
    });

    it('treats a chunk with no kind as content → responding…', () => {
        expect(phaseOf(ev('llm.chunk', { delta: 'x' }))).toBe('responding…');
    });

    it('maps llm.request → responding…', () => {
        expect(phaseOf(ev('llm.request', { model: 'm', messages: [] }))).toBe('responding…');
    });

    it('maps tool.called → running {tool_name}', () => {
        expect(phaseOf(ev('tool.called', { tool_name: 'bash', args: {}, call_id: 'c1' }))).toBe(
            'running bash',
        );
    });

    it('special-cases ask_agent → asking {callee} from args', () => {
        const e = ev('tool.called', {
            tool_name: 'ask_agent',
            args: { target_agent_id: 'agent-reviewer', brief: 'hi' },
            call_id: 'c2',
        });
        expect(phaseOf(e)).toBe('asking agent-reviewer');
    });

    it('falls back to a generic ask label when the callee arg is missing', () => {
        const e = ev('tool.called', { tool_name: 'ask_agent', args: {}, call_id: 'c3' });
        expect(phaseOf(e)).toBe('asking agent');
    });

    it('maps model_router.fell_through → retrying model', () => {
        const e = ev('model_router.fell_through', {
            from_model_node_id: 'a',
            from_model_id: 'm1',
            to_model_node_id: 'b',
            to_model_id: 'm2',
            reason: '429',
        });
        expect(phaseOf(e)).toBe('retrying model');
    });

    it('clears on llm.response (returns null)', () => {
        const e = ev('llm.response', { content: 'done', finish_reason: 'stop' });
        expect(phaseOf(e)).toBeNull();
    });

    it('clears on output.emitted (returns null)', () => {
        const e = ev('output.emitted', { port: 'result', messages: [] });
        expect(phaseOf(e)).toBeNull();
    });

    it('returns null for events with no phase contribution (gateway.received)', () => {
        const e = ev('gateway.received', { source: 'webchat:c', messages: [] });
        expect(phaseOf(e)).toBeNull();
    });
});
