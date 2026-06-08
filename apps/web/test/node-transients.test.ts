import { describe, expect, it } from 'vitest';
import type { Node, ObservabilityEvent } from '@fabritorio/types';
import {
    argPreview,
    buildTransientReducer,
    formatToolTap,
    TransientReducer,
} from '../lib/node-transients';

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

function l1Graph(): { nodes: Node[] } {
    const nodes: Node[] = [
        { id: 'gateway-1', type: 'gateway', position: { x: 0, y: 0 } } as Node,
        { id: 'handler-1', type: 'handler', position: { x: 0, y: 0 }, max_iterations: 5 } as Node,
        { id: 'model-a', type: 'model', position: { x: 0, y: 0 } } as Node,
        { id: 'model-b', type: 'model', position: { x: 0, y: 0 } } as Node,
        { id: 'router-1', type: 'model_router', position: { x: 0, y: 0 } } as Node,
        { id: 'tool-1', type: 'tool', position: { x: 0, y: 0 } } as Node,
        { id: 'output-1', type: 'output', position: { x: 0, y: 0 } } as Node,
    ];
    return { nodes };
}

function l2Graph(): { nodes: Node[] } {
    return {
        nodes: [{ id: 'agent-a', type: 'native_agent', position: { x: 0, y: 0 } } as Node],
    };
}

describe('argPreview / formatToolTap', () => {
    it('prefers the bash `command` arg', () => {
        expect(argPreview({ command: 'ls -la', cwd: '/tmp' })).toBe('ls -la');
    });

    it('falls back to the first string-valued arg', () => {
        expect(argPreview({ count: 3, note: 'hello there' })).toBe('hello there');
    });

    it('JSON-stringifies when no string arg exists', () => {
        expect(argPreview({ count: 3, flag: true })).toBe('{"count":3,"flag":true}');
    });

    it('returns empty for no args', () => {
        expect(argPreview({})).toBe('');
    });

    it('collapses whitespace and truncates long previews', () => {
        const long = 'echo ' + 'x'.repeat(80);
        const out = argPreview({ command: long });
        expect(out.length).toBeLessThanOrEqual(48);
        expect(out.endsWith('…')).toBe(true);
    });

    it('formats the tap as `tool ▸ preview`, name-only when no args', () => {
        expect(formatToolTap('bash', { command: 'pwd' })).toBe('bash ▸ pwd');
        expect(formatToolTap('list_dir', {})).toBe('list_dir');
    });
});

describe('TransientReducer — tool console tap', () => {
    it('stamps the arg preview on tool.called and the ✓/✗ on tool.result', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(
            ev('tool.called', 'tool-1', {
                tool_name: 'bash',
                args: { command: 'ls' },
                call_id: 'c1',
            }),
        );
        expect(r.transientFor('tool-1')?.toolArgPreview).toBe('bash ▸ ls');
        expect(r.transientFor('tool-1')?.toolExitOk).toBeUndefined();

        r.ingest(
            ev('tool.result', 'tool-1', { call_id: 'c1', stdout: '', stderr: '', exit_code: 0 }),
        );
        expect(r.transientFor('tool-1')?.toolExitOk).toBe(true);

        r.ingest(
            ev('tool.called', 'tool-1', {
                tool_name: 'bash',
                args: { command: 'false' },
                call_id: 'c2',
            }),
        );
        expect(r.transientFor('tool-1')?.toolExitOk).toBeUndefined();
        r.ingest(
            ev('tool.result', 'tool-1', { call_id: 'c2', stdout: '', stderr: 'x', exit_code: 1 }),
        );
        expect(r.transientFor('tool-1')?.toolExitOk).toBe(false);
    });

    it('attributes the tap to the L2 stand-in for off-canvas tool events', () => {
        const r = new TransientReducer(l2Graph());
        r.ingest(ev('gateway.received', 'agent-a', { source: 'webchat:c', messages: [] }));
        r.ingest(
            ev('tool.called', 'tool-off', {
                tool_name: 'bash',
                args: { command: 'id' },
                call_id: 'c1',
            }),
        );
        expect(r.transientFor('agent-a')?.toolArgPreview).toBe('bash ▸ id');
    });
});

describe('TransientReducer — model-router cascade', () => {
    it('highlights model_node_id on attempt (not the router node)', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(
            ev('model_router.attempted', 'router-1', {
                model_node_id: 'model-a',
                model_id: 'gpt-a',
                attempt: 0,
            }),
        );
        expect(r.transientFor('model-a')?.routerTrying).toBe('gpt-a');
        expect(r.transientFor('router-1')).toBeNull();
    });

    it('flashes the from-model rose with reason and marks the to-model next', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(
            ev('model_router.attempted', 'router-1', {
                model_node_id: 'model-a',
                model_id: 'gpt-a',
                attempt: 0,
            }),
        );
        r.ingest(
            ev('model_router.fell_through', 'router-1', {
                from_model_node_id: 'model-a',
                from_model_id: 'gpt-a',
                to_model_node_id: 'model-b',
                to_model_id: 'gpt-b',
                reason: '429 Too Many Requests',
            }),
        );
        expect(r.transientFor('model-a')?.fellThroughReason).toBe('429 Too Many Requests');
        expect(r.transientFor('model-a')?.routerTrying).toBeUndefined();
        expect(r.transientFor('model-b')?.routerTrying).toBe('gpt-b');
    });

    it('a fresh attempt on a model clears its stale fall-through flash', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(
            ev('model_router.fell_through', 'router-1', {
                from_model_node_id: 'model-a',
                from_model_id: 'gpt-a',
                to_model_node_id: 'model-b',
                to_model_id: 'gpt-b',
                reason: 'ECONNREFUSED',
            }),
        );
        expect(r.transientFor('model-a')?.fellThroughReason).toBe('ECONNREFUSED');
        r.ingest(
            ev('model_router.attempted', 'router-1', {
                model_node_id: 'model-a',
                model_id: 'gpt-a',
                attempt: 1,
            }),
        );
        expect(r.transientFor('model-a')?.fellThroughReason).toBeUndefined();
        expect(r.transientFor('model-a')?.routerTrying).toBe('gpt-a');
    });
});

describe('TransientReducer — chain.stopped reason', () => {
    it('surfaces the reason on the resolved owner', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(
            ev('chain.stopped', 'handler-1', { reason: 'dispatch terminated without output' }),
        );
        expect(r.transientFor('handler-1')?.stoppedReason).toBe(
            'dispatch terminated without output',
        );
    });

    it('falls back to a generic reason when absent', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(ev('chain.stopped', 'handler-1', {}));
        expect(r.transientFor('handler-1')?.stoppedReason).toBe('stopped');
    });

    it('attributes the stop to the L2 stand-in', () => {
        const r = new TransientReducer(l2Graph());
        r.ingest(ev('gateway.received', 'agent-a', { source: 'webchat:c', messages: [] }));
        r.ingest(ev('chain.stopped', 'agent-off', { reason: 'agent not activated' }));
        expect(r.transientFor('agent-a')?.stoppedReason).toBe('agent not activated');
    });
});

describe('TransientReducer — iteration pips', () => {
    it('counts llm.request per eventId and attributes to the drilled-in handler with its max', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(ev('gateway.received', 'gateway-1', { source: 'webchat:c', messages: [] }));
        r.ingest(ev('llm.request', 'model-a', { model: 'm', messages: [] }));
        expect(r.transientFor('handler-1')?.iter).toEqual({ n: 1, max: 5 });
        r.ingest(ev('llm.request', 'model-a', { model: 'm', messages: [] }));
        expect(r.transientFor('handler-1')?.iter).toEqual({ n: 2, max: 5 });
    });

    it('omits /max for a handler with no max_iterations', () => {
        const graph: { nodes: Node[] } = {
            nodes: [
                { id: 'gateway-1', type: 'gateway', position: { x: 0, y: 0 } } as Node,
                { id: 'handler-x', type: 'handler', position: { x: 0, y: 0 } } as Node,
                { id: 'model-a', type: 'model', position: { x: 0, y: 0 } } as Node,
            ],
        };
        const r = new TransientReducer(graph);
        r.ingest(ev('gateway.received', 'gateway-1', { source: 'webchat:c', messages: [] }));
        r.ingest(ev('llm.request', 'model-a', { model: 'm', messages: [] }));
        expect(r.transientFor('handler-x')?.iter).toEqual({ n: 1 });
    });

    it('attributes iter to the L2 stand-in (no max available there)', () => {
        const r = new TransientReducer(l2Graph());
        r.ingest(ev('gateway.received', 'agent-a', { source: 'webchat:c', messages: [] }));
        r.ingest(ev('llm.request', 'model-off', { model: 'm', messages: [] }));
        r.ingest(ev('llm.request', 'model-off', { model: 'm', messages: [] }));
        expect(r.transientFor('agent-a')?.iter).toEqual({ n: 2 });
    });

    it('does not count llm.request from a Dispatch not on this canvas', () => {
        const r = new TransientReducer(l1Graph());
        r.ingest(ev('llm.request', 'model-off-canvas', { model: 'm', messages: [] }, 'd-sibling'));
        expect(r.transientFor('handler-1')).toBeNull();
    });
});

describe('buildTransientReducer — seed from store snapshot', () => {
    it('reconstructs mid-dispatch transient state for a drill-in', () => {
        const events: ObservabilityEvent[] = [
            ev('gateway.received', 'gateway-1', { source: 'webchat:c', messages: [] }),
            ev('llm.request', 'model-a', { model: 'm', messages: [] }),
            ev('tool.called', 'tool-1', {
                tool_name: 'bash',
                args: { command: 'pwd' },
                call_id: 'c1',
            }),
        ];
        const r = buildTransientReducer(l1Graph(), events);
        expect(r.transientFor('tool-1')?.toolArgPreview).toBe('bash ▸ pwd');
        expect(r.transientFor('handler-1')?.iter).toEqual({ n: 1, max: 5 });
    });
});
