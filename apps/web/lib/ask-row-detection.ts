import type { DispatchEvent, ObservabilityEvent, ToolCalledEvent } from '@fabritorio/types';

type Event = DispatchEvent | ObservabilityEvent;

export interface AskRowMatch {
    askCallId: string;
    childEventId: string;
    callerNodeId: string;
    calleeNodeId: string;
}

function isAskAgentCall(event: Event): event is ToolCalledEvent {
    return 'type' in event && event.type === 'tool.called' && event.tool_name === 'ask_agent';
}

function findPairedCall(events: ReadonlyArray<Event>, callId: string): ToolCalledEvent | null {
    for (const ev of events) {
        if (!isAskAgentCall(ev)) continue;
        if (ev.call_id === callId) return ev;
    }
    return null;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | null {
    if (!record) return null;
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function findCallerNodeId(events: ReadonlyArray<Event>, dispatchEventId: string): string | null {
    for (const ev of events) {
        if (!('type' in ev)) continue;
        if (ev.type !== 'gateway.received') continue;
        if (ev.eventId !== dispatchEventId) continue;
        if (typeof ev.node_id === 'string' && ev.node_id.length > 0) return ev.node_id;
    }
    return null;
}

export function isAskAgentResult(
    event: Event,
    allEvents: ReadonlyArray<Event>,
): AskRowMatch | null {
    if (!('type' in event)) return null;
    if (event.type !== 'tool.result') return null;
    const childEventId = event.child_event_id;
    if (typeof childEventId !== 'string' || childEventId.length === 0) return null;

    const paired = findPairedCall(allEvents, event.call_id);
    if (!paired) return null;

    const calleeNodeId = readString(paired.args, 'target_agent_id');
    if (!calleeNodeId) return null;

    const callerNodeId = findCallerNodeId(allEvents, event.eventId);
    if (!callerNodeId) return null;

    return {
        askCallId: event.call_id,
        childEventId,
        callerNodeId,
        calleeNodeId,
    };
}
