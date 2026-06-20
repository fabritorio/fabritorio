import type { BaseNode } from './base.js';

export interface ChannelNode extends BaseNode {
    type: 'channel';
    channel_kind: 'webchat';
    display_name?: string;
    owner_node_id?: string;
}

export type ScheduleRecurrence =
    | { kind: 'interval'; every: string }
    | { kind: 'daily'; time: string }
    | { kind: 'weekly'; time: string; days: number[] };

export interface TriggerNode extends BaseNode {
    type: 'trigger';
    trigger_kind: 'cron' | 'schedule' | 'webhook' | 'manual' | 'event';
    instructions?: string;
    expression?: string;
    at?: string;
    recurrence?: ScheduleRecurrence;
    from?: string;
    until?: string;
    path?: string;
    method?: 'GET' | 'POST';
    topic?: string;
    paused?: boolean;
    display_name?: string;
}

export interface NativeAgentNode extends BaseNode {
    type: 'native_agent';
    l1_graph_id: string;
    display_name?: string;
    description?: string;
}

export interface MemoryNode extends BaseNode {
    type: 'memory';
    storage: 'in_memory' | 'local_storage';
    storage_kind: 'kv' | 'markdown' | 'static_string';
    handling: 'none' | 'always_inject' | 'full_history' | 'last_n' | 'last_within_tokens';
    tool_access: 'none' | 'read' | 'read_write';
    content?: string;
    n?: number;
    token_budget?: number;
}
