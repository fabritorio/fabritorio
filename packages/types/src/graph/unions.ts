import type {
    CheckpointNode,
    GatewayNode,
    HandlerNode,
    ModelNode,
    ModelRouterNode,
    OutputNode,
    PermissionNode,
    SkillNode,
    SkillPackNode,
    ToolNode,
    ToolPackNode,
    WorkspaceNode,
} from './agent.js';
import type { DebugGatewayNode, DebugProbeNode } from './debug.js';
import type {
    EvaluatorNode,
    HandlerInputNode,
    HandlerOutputNode,
    ModelCallNode,
    PromptBuilderNode,
    ToolExecNode,
} from './handler.js';
import type { ChannelNode, MemoryNode, NativeAgentNode, TriggerNode } from './orchestration.js';
import type { SecretsNode } from './secrets.js';

export type ToolPackNodeContents = ToolNode | ToolPackNode;

export type SkillPackNodeContents = SkillNode | SkillPackNode;

export type HandlerNodeContents =
    | HandlerInputNode
    | HandlerOutputNode
    | PromptBuilderNode
    | ModelCallNode
    | ToolExecNode
    | EvaluatorNode
    | DebugProbeNode;

export type Node =
    | GatewayNode
    | OutputNode
    | HandlerNode
    | ModelNode
    | ModelRouterNode
    | ToolNode
    | SkillNode
    | WorkspaceNode
    | ToolPackNode
    | SkillPackNode
    | PermissionNode
    | CheckpointNode
    | SecretsNode
    | ChannelNode
    | TriggerNode
    | NativeAgentNode
    | MemoryNode
    | DebugGatewayNode
    | DebugProbeNode
    | HandlerNodeContents;
export type NodeType = Node['type'];
