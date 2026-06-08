import { describe, expect, it } from 'vitest';
import type {
    DispatchEvent,
    GatewayReceivedEvent,
    ObservabilityEvent,
    ToolCalledEvent,
    ToolResultEvent,
} from '@fabritorio/types';
import { isAskAgentResult } from '../lib/ask-row-detection';

const DISPATCH_EVENT_ID = 'evt-trigger-root';
const CHILD_EVENT_ID = 'evt-child-dispatch';

function gatewayReceived(nodeId: string): GatewayReceivedEvent {
    return {
        type: 'gateway.received',
        ts: '2024-01-01T00:00:00.000Z',
        eventId: DISPATCH_EVENT_ID,
        node_id: nodeId,
        source: `trigger:${nodeId}`,
        messages: [],
    };
}

function toolCalled(opts: {
    callId: string;
    toolName: string;
    args?: Record<string, unknown>;
    nodeId?: string;
}): ToolCalledEvent {
    return {
        type: 'tool.called',
        ts: '2024-01-01T00:00:01.000Z',
        eventId: DISPATCH_EVENT_ID,
        node_id: opts.nodeId ?? 'inner-tool-node',
        tool_name: opts.toolName,
        args: opts.args ?? {},
        call_id: opts.callId,
    };
}

function toolResult(opts: {
    callId: string;
    childEventId?: string;
    exitCode?: number;
}): ToolResultEvent {
    return {
        type: 'tool.result',
        ts: '2024-01-01T00:00:02.000Z',
        eventId: DISPATCH_EVENT_ID,
        node_id: 'inner-tool-node',
        call_id: opts.callId,
        stdout: '',
        stderr: '',
        exit_code: opts.exitCode ?? 0,
        ...(opts.childEventId !== undefined ? { child_event_id: opts.childEventId } : {}),
    };
}

describe('isAskAgentResult', () => {
    it('returns the correlation triple for a paired ask_agent tool.result', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            gatewayReceived('agentA'),
            toolCalled({
                callId: 'call-1',
                toolName: 'ask_agent',
                args: { target_agent_id: 'agentB', brief: 'help' },
            }),
            toolResult({ callId: 'call-1', childEventId: CHILD_EVENT_ID }),
        ];
        const result = events[2] as ToolResultEvent;
        const match = isAskAgentResult(result, events);
        expect(match).toEqual({
            askCallId: 'call-1',
            childEventId: CHILD_EVENT_ID,
            callerNodeId: 'agentA',
            calleeNodeId: 'agentB',
        });
    });

    it('returns the correlation triple for a failed ask (exit_code 1)', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            gatewayReceived('agentA'),
            toolCalled({
                callId: 'call-fail',
                toolName: 'ask_agent',
                args: { target_agent_id: 'agentB', brief: 'help' },
            }),
            toolResult({ callId: 'call-fail', childEventId: CHILD_EVENT_ID, exitCode: 1 }),
        ];
        const result = events[2] as ToolResultEvent;
        const match = isAskAgentResult(result, events);
        expect(match?.childEventId).toBe(CHILD_EVENT_ID);
        expect(match?.calleeNodeId).toBe('agentB');
    });

    it('returns null when the tool.result has no child_event_id', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            gatewayReceived('agentA'),
            toolCalled({
                callId: 'call-1',
                toolName: 'ask_agent',
                args: { target_agent_id: 'agentB' },
            }),
            toolResult({ callId: 'call-1' }),
        ];
        expect(isAskAgentResult(events[2] as ToolResultEvent, events)).toBeNull();
    });

    it('returns null for tool.result rows whose paired tool.called is not ask_agent', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            gatewayReceived('agentA'),
            toolCalled({ callId: 'call-1', toolName: 'bash', args: { cmd: 'ls' } }),
            toolResult({ callId: 'call-1', childEventId: CHILD_EVENT_ID }),
        ];
        expect(isAskAgentResult(events[2] as ToolResultEvent, events)).toBeNull();
    });

    it('returns null when no paired tool.called exists in the event list', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            gatewayReceived('agentA'),
            toolResult({ callId: 'orphan', childEventId: CHILD_EVENT_ID }),
        ];
        expect(isAskAgentResult(events[1] as ToolResultEvent, events)).toBeNull();
    });

    it('returns null when ask_agent args lack a target_agent_id', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            gatewayReceived('agentA'),
            toolCalled({ callId: 'call-1', toolName: 'ask_agent', args: {} }),
            toolResult({ callId: 'call-1', childEventId: CHILD_EVENT_ID }),
        ];
        expect(isAskAgentResult(events[2] as ToolResultEvent, events)).toBeNull();
    });

    it('returns null when no gateway.received in the same dispatch is present', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            toolCalled({
                callId: 'call-1',
                toolName: 'ask_agent',
                args: { target_agent_id: 'agentB' },
            }),
            toolResult({ callId: 'call-1', childEventId: CHILD_EVENT_ID }),
        ];
        expect(isAskAgentResult(events[1] as ToolResultEvent, events)).toBeNull();
    });

    it('returns null for non-tool.result observability events', () => {
        const events: Array<DispatchEvent | ObservabilityEvent> = [
            gatewayReceived('agentA'),
            toolCalled({
                callId: 'call-1',
                toolName: 'ask_agent',
                args: { target_agent_id: 'agentB' },
            }),
        ];
        const called = events[1] as ToolCalledEvent;
        expect(isAskAgentResult(called, events)).toBeNull();
    });

    it('returns null for raw DispatchEvent rows (no `type` field)', () => {
        const dispatch: DispatchEvent = {
            eventId: DISPATCH_EVENT_ID,
            source: `trigger:agentA`,
            timestamp: 0,
            messages: [],
        };
        const events: Array<DispatchEvent | ObservabilityEvent> = [dispatch];
        expect(isAskAgentResult(dispatch, events)).toBeNull();
    });
});
