import { describe, expect, it } from 'vitest';
import type { Node, ObservabilityEvent } from '@fabritorio/types';
import { DispatchIndex, buildDispatchIndex } from '../lib/dispatch-index';

function ev(
    type: ObservabilityEvent['type'],
    node_id: string,
    extra: Record<string, unknown> = {},
    eventId = 'd-1',
): ObservabilityEvent {
    return {
        type,
        ts: '2026-05-29T00:00:00.000Z',
        eventId,
        node_id,
        ...extra,
    } as ObservabilityEvent;
}

function l2DispatchSequence(): ObservabilityEvent[] {
    return [
        ev('gateway.received', 'agent-a04', { source: 'webchat:channel__fr5143', messages: [] }),
        ev('llm.request', 'model-f4c', { model: 'gemma', messages: [] }),
        ev('llm.chunk', 'model-f4c', { kind: 'reasoning', delta: 'hm' }),
        ev('llm.chunk', 'model-f4c', { kind: 'reasoning', delta: ' more' }),
        ev('llm.chunk', 'model-f4c', { kind: 'content', delta: 'answer' }),
        ev('llm.response', 'model-f4c', { content: 'answer', finish_reason: 'tool_calls' }),
        ev('tool.called', 'tools-rjp', { tool_name: 'bash', args: {}, call_id: 'c1' }),
        ev('tool.result', 'tools-rjp', { call_id: 'c1', stdout: 'ok', stderr: '', exit_code: 0 }),
        ev('llm.request', 'model-f4c', { model: 'gemma', messages: [] }),
        ev('llm.chunk', 'model-f4c', { kind: 'content', delta: 'final' }),
        ev('llm.response', 'model-f4c', { content: 'final', finish_reason: 'stop' }),
        ev('output.emitted', 'output-j4l', { port: 'result', messages: [] }),
    ];
}

function l2Graph(): { nodes: Node[] } {
    const agent: Node = { id: 'agent-a04', type: 'native_agent', position: { x: 0, y: 0 } } as Node;
    return { nodes: [agent] };
}

function l1Graph(): { nodes: Node[] } {
    const nodes: Node[] = [
        { id: 'gateway-1', type: 'gateway', position: { x: 0, y: 0 } } as Node,
        { id: 'model-f4c', type: 'model', position: { x: 0, y: 0 } } as Node,
        { id: 'tools-rjp', type: 'tool', position: { x: 0, y: 0 } } as Node,
        { id: 'output-j4l', type: 'output', position: { x: 0, y: 0 } } as Node,
    ];
    return { nodes };
}

describe('DispatchIndex — stand-in resolution at L2', () => {
    it('resolves every off-canvas inner event to the on-canvas stand-in', () => {
        const index = new DispatchIndex(l2Graph());
        const seq = l2DispatchSequence();
        index.ingest(seq[0]!);
        expect(index.standInFor('d-1')).toBe('agent-a04');
        for (const e of seq.slice(1)) {
            expect(index.resolveOwner(e)).toBe('agent-a04');
        }
    });

    it('ignores events from a Dispatch with no on-canvas receiver', () => {
        const index = new DispatchIndex(l2Graph());
        const sibling = ev('llm.chunk', 'model-zzz', { kind: 'content', delta: 'x' }, 'd-other');
        expect(index.resolveOwner(sibling)).toBeNull();
    });

    it('drives the expected phase-label sequence onto the stand-in', () => {
        const index = new DispatchIndex(l2Graph());
        const seq = l2DispatchSequence();
        const labels: Array<string | null> = [];
        for (const e of seq) {
            index.ingest(e);
            labels.push(index.phaseFor('agent-a04'));
        }
        expect(labels).toEqual([
            null, // gateway.received — no phase
            'responding…', // llm.request
            'thinking…', // llm.chunk reasoning
            'thinking…', // llm.chunk reasoning
            'responding…', // llm.chunk content
            null, // llm.response — clears
            'running bash', // tool.called
            null, // tool.result — no phase contribution; owner stays cleared
            'responding…', // llm.request (second turn)
            'responding…', // llm.chunk content
            null, // llm.response — clears
            null, // output.emitted — clears
        ]);
    });
});

describe('DispatchIndex — direct node resolution when drilled in', () => {
    it('resolves inner events to their own node_id on the owning L1 canvas', () => {
        const index = new DispatchIndex(l1Graph());
        index.seedFromEvents(l2DispatchSequence());
        expect(
            index.resolveOwner(ev('llm.chunk', 'model-f4c', { kind: 'content', delta: 'x' })),
        ).toBe('model-f4c');
        expect(index.phaseFor('model-f4c')).toBeNull();
        expect(index.phaseFor('tools-rjp')).toBeNull();
        expect(index.phaseFor('output-j4l')).toBeNull();
    });
});

describe('DispatchIndex — reconstruction from a mid-dispatch store snapshot', () => {
    it('seeds the latest phase per owner from the store with no live events', () => {
        const midDispatch = l2DispatchSequence().slice(
            0,
            l2DispatchSequence().findIndex((e) => e.type === 'tool.called') + 1,
        );
        const index = buildDispatchIndex(l2Graph(), midDispatch);
        expect(index.phaseFor('agent-a04')).toBe('running bash');
    });

    it('reconstructs a thinking phase mid-reasoning', () => {
        const upToReasoning = l2DispatchSequence().slice(0, 3);
        const index = buildDispatchIndex(l2Graph(), upToReasoning);
        expect(index.phaseFor('agent-a04')).toBe('thinking…');
    });

    it('drilled-in reconstruction lands the right node mid-tool-call', () => {
        const midDispatch = l2DispatchSequence().slice(
            0,
            l2DispatchSequence().findIndex((e) => e.type === 'tool.called') + 1,
        );
        const index = buildDispatchIndex(l1Graph(), midDispatch);
        expect(index.phaseFor('tools-rjp')).toBe('running bash');
        expect(index.phaseFor('model-f4c')).toBeNull();
    });
});
