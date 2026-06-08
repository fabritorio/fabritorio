import type { BaseNode } from './base.js';

export interface GatewayNode extends BaseNode {
    type: 'gateway';
}

export interface OutputNode extends BaseNode {
    type: 'output';
    ports?: string[];
}

export interface HandlerNode extends BaseNode {
    type: 'handler';
    name?: string;
    ref_id?: string;
    max_iterations?: number;
}

export interface ModelNode extends BaseNode {
    type: 'model';
    provider: string;
    model_id: string;
    auth_env?: string;
    base_url?: string;
    temperature?: number;
    max_tokens?: number;
    system_prompt?: string;
    reasoning?: boolean;
}

export interface ModelRouterNode extends BaseNode {
    type: 'model_router';
    policy: 'failover';
}

export interface ToolNode extends BaseNode {
    type: 'tool';
    tool_name: string;
    config?: Record<string, unknown>;
}

export interface SkillNode extends BaseNode {
    type: 'skill';
    name: string;
}

export interface WorkspaceNode extends BaseNode {
    type: 'workspace';
    path: string;
    permissions: 'read' | 'read-write';
}

export interface ToolPackNode extends BaseNode {
    type: 'tool_pack';
    pack_name?: string;
    ref_id?: string;
}

export interface SkillPackNode extends BaseNode {
    type: 'skill_pack';
    pack_name?: string;
    ref_id?: string;
}

export interface PermissionNode extends BaseNode {
    type: 'permission';
    strategy?: 'call_user';
    label?: string;
}

export type CheckpointCadence =
    | { kind: 'iterations'; at: number[] }
    | { kind: 'tokens'; at_fraction: number };

export interface CheckpointNode extends BaseNode {
    type: 'checkpoint';
    strategy: 'supervisor' | 'mutator';
    cadence: CheckpointCadence;
    agent_id: string;
    window?: number;
    keep_last?: number;
}
