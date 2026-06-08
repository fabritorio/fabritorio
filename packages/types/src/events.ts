import type { DispatchEvent, Message, ToolCall } from './messages.js';

export interface BaseEvent {
    ts: string;
    eventId: string;
    parentId?: string;
    node_id: string;
    port_id?: string;
}

export interface LlmRequestEvent extends BaseEvent {
    type: 'llm.request';
    model: string;
    messages: Message[];
    tools?: unknown[];
}

export interface LlmChunkEvent extends BaseEvent {
    type: 'llm.chunk';
    delta: string;
    kind?: 'content' | 'reasoning';
}

export interface LlmResponseEvent extends BaseEvent {
    type: 'llm.response';
    content: string;
    reasoning?: string;
    tool_calls?: ToolCall[];
    finish_reason: string;
}

export interface ToolCalledEvent extends BaseEvent {
    type: 'tool.called';
    tool_name: string;
    args: Record<string, unknown>;
    call_id: string;
}

export interface ToolResultEvent extends BaseEvent {
    type: 'tool.result';
    call_id: string;
    stdout: string;
    stderr: string;
    exit_code: number;
    child_event_id?: string;
}

export interface GatewayReceivedEvent extends BaseEvent {
    type: 'gateway.received';
    source: string;
    messages: Message[];
}

export interface OutputEmittedEvent extends BaseEvent {
    type: 'output.emitted';
    port: string;
    messages: Message[];
}

export interface WorkspaceFileEvent extends BaseEvent {
    type: 'workspace.file';
    action: 'created' | 'modified' | 'deleted';
    path: string;
}

export interface ChainStoppedEvent extends BaseEvent {
    type: 'chain.stopped';
    reason?: string;
}

export interface DispatchStoppedEvent extends BaseEvent {
    type: 'dispatch.stopped';
    reason?: string;
}

export interface ModelRouterAttemptedEvent extends BaseEvent {
    type: 'model_router.attempted';
    model_node_id: string;
    model_id: string;
    attempt: number;
}

export interface ModelRouterFellThroughEvent extends BaseEvent {
    type: 'model_router.fell_through';
    from_model_node_id: string;
    from_model_id: string;
    to_model_node_id: string;
    to_model_id: string;
    reason: string;
}

export interface EdgeTraversedEvent {
    type: 'edge.traversed';
    ts: string;
    eventId: string;
    graphId: string;
    fromNodeId: string;
    toNodeId: string;
    edgeId: string;
    direction: 'forward' | 'reverse';
    portHint?: 'result' | 'error';
}

export type ObservabilityEvent =
    | LlmRequestEvent
    | LlmChunkEvent
    | LlmResponseEvent
    | ToolCalledEvent
    | ToolResultEvent
    | GatewayReceivedEvent
    | OutputEmittedEvent
    | WorkspaceFileEvent
    | ChainStoppedEvent
    | DispatchStoppedEvent
    | ModelRouterAttemptedEvent
    | ModelRouterFellThroughEvent;

export type ObservabilityEventType = ObservabilityEvent['type'];

export interface ActiveAsk {
    askCallId: string;
    targetNodeId: string;
    startedAt: number;
}

export interface NodeRuntimeState {
    nodeId: string;
    dispatchEventId: string;
    phase: 'running' | 'asking';
    startedAt: number;
    activeAsks: ActiveAsk[];
}

export type NodeRuntimeStateWire = NodeRuntimeState;

export interface AskCallSummary {
    eventId: string;
    askCallId: string;
    calleeNodeId: string;
    status: 'ok' | 'failed' | 'running';
    startedAt: number;
    durationMs: number | null;
    briefSnippet: string;
    resultSnippet: string | null;
}

export interface AskCallDetail {
    call: {
        brief: string;
        askChain: string[];
        inheritSession: boolean;
        timeoutMs: number;
        calleeNodeId: string;
        callerNodeId: string;
    };
    response: {
        stdout: string;
        exitCode: number;
        status: 'ok' | 'failed' | 'running';
        durationMs: number | null;
    };
    internal: Array<DispatchEvent | ObservabilityEvent>;
}
