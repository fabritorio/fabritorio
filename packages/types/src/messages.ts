export interface Message {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    name?: string;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface DispatchEvent {
    eventId: string;
    parentId?: string;
    source: string;
    timestamp: number;
    messages: Message[];
    meta?: Record<string, unknown>;
}
