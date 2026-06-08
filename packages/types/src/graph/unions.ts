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
import type { CliInvocationTargetNode } from './cli-invocation.js';
import type { DebugGatewayNode, DebugProbeNode } from './debug.js';
import type {
    EvaluatorNode,
    HandlerInputNode,
    HandlerOutputNode,
    ModelCallNode,
    PromptBuilderNode,
    ToolExecNode,
} from './handler.js';
import type {
    ChannelNode,
    CliAgentNode,
    GoClaudeAgentNode,
    MemoryNode,
    NativeAgentNode,
    PiAgentNode,
    TriggerNode,
} from './orchestration.js';
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

export type CliInvocationNodeContents =
    | ModelNode
    | WorkspaceNode
    | SkillNode
    | SkillPackNode
    | CliInvocationTargetNode;

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
    | CliAgentNode
    | GoClaudeAgentNode
    | PiAgentNode
    | MemoryNode
    | DebugGatewayNode
    | DebugProbeNode
    | HandlerNodeContents
    | CliInvocationTargetNode;
export type NodeType = Node['type'];
