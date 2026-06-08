import type { Node, NodeType } from '@fabritorio/types';
import { findConnectionRule } from './palette';

export type PortKind = 'reference' | 'event';
export type PortDirection = 'in' | 'out';

export interface PortSpec {
    id: string;
    kind: PortKind;
    direction: PortDirection;
}

export const HANDLER_PORTS = {
    toolsIn: { id: 'tools-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
    gatewayIn: { id: 'gateway-in', kind: 'event', direction: 'in' },
    modelOut: { id: 'model-out', kind: 'reference', direction: 'out' },
    outputOut: { id: 'output-out', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const MODEL_PORTS = {
    toolsIn: { id: 'tools-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
    gatewayIn: { id: 'gateway-in', kind: 'event', direction: 'in' },
    modelIn: { id: 'model-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const TOOL_PORTS = {
    toolOut: { id: 'tool-out', kind: 'reference', direction: 'out' },
    secretsIn: { id: 'tool-secrets-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const TOOL_PACK_PORTS = {
    toolOut: { id: 'tool-out', kind: 'reference', direction: 'out' },
    secretsIn: { id: 'tool-pack-secrets-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const PERMISSION_PORTS = {
    toolsIn: { id: 'permission-tools-in', kind: 'reference', direction: 'in' },
    toolsOut: { id: 'permission-tools-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const CHECKPOINT_PORTS = {
    handlerOut: { id: 'checkpoint-handler-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const SKILL_PORTS = {
    skillOut: { id: 'skill-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const WORKSPACE_PORTS = {
    workspaceOut: { id: 'workspace-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const SECRETS_PORTS = {
    secretsOut: { id: 'secrets-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const GATEWAY_PORTS = {
    gatewayIn: { id: 'gateway-in', kind: 'event', direction: 'in' },
    gatewayOut: { id: 'gateway-out', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const OUTPUT_PORTS = {
    outputIn: { id: 'output-in', kind: 'event', direction: 'in' },
    resultOut: { id: 'result', kind: 'event', direction: 'out' },
    errorOut: { id: 'error', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const CHANNEL_PORTS = {
    out: { id: 'channel-out', kind: 'event', direction: 'out' },
    in: { id: 'channel-in', kind: 'event', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const TRIGGER_PORTS = {
    out: { id: 'trigger-out', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const DEBUG_GATEWAY_PORTS = {
    out: { id: 'debug-out', kind: 'event', direction: 'out' },
    in: { id: 'debug-in', kind: 'event', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const DEBUG_PROBE_PORTS = {
    attachOut: { id: 'probe-attach-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

export const NATIVE_AGENT_PORTS = {
    gatewayIn: { id: 'agent-gateway-in', kind: 'event', direction: 'in' },
    outputOut: { id: 'agent-output-out', kind: 'event', direction: 'out' },
    memoryIn: { id: 'memory-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const CLI_AGENT_PORTS = {
    gatewayIn: { id: 'agent-gateway-in', kind: 'event', direction: 'in' },
    outputOut: { id: 'agent-output-out', kind: 'event', direction: 'out' },
    memoryIn: { id: 'memory-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const PI_AGENT_PORTS = {
    gatewayIn: { id: 'agent-gateway-in', kind: 'event', direction: 'in' },
    outputOut: { id: 'agent-output-out', kind: 'event', direction: 'out' },
    memoryIn: { id: 'memory-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortSpec>;

export const MEMORY_PORTS = {
    out: { id: 'memory-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortSpec>;

function l1DefaultOut(sourceType: string, targetType?: string): string {
    if (!targetType) return '';
    const rule = findConnectionRule('l1', sourceType as NodeType, targetType as NodeType);
    return rule?.sourcePort ?? '';
}

function l1DefaultIn(sourceType: string, targetType: string): string {
    const rule = findConnectionRule('l1', sourceType as NodeType, targetType as NodeType);
    return rule?.targetPort ?? '';
}

export function defaultOutPortL1(sourceType: string, targetType?: string): string {
    return l1DefaultOut(sourceType, targetType);
}

export function defaultInPortL1(sourceType: string, targetType: string): string {
    return l1DefaultIn(sourceType, targetType);
}

const L1_PORT_KIND: Record<string, Record<string, PortKind>> = {
    handler: {
        [HANDLER_PORTS.toolsIn.id]: HANDLER_PORTS.toolsIn.kind,
        [HANDLER_PORTS.skillsIn.id]: HANDLER_PORTS.skillsIn.kind,
        [HANDLER_PORTS.workspaceIn.id]: HANDLER_PORTS.workspaceIn.kind,
        [HANDLER_PORTS.gatewayIn.id]: HANDLER_PORTS.gatewayIn.kind,
        [HANDLER_PORTS.modelOut.id]: HANDLER_PORTS.modelOut.kind,
        [HANDLER_PORTS.outputOut.id]: HANDLER_PORTS.outputOut.kind,
    },
    model: {
        [MODEL_PORTS.toolsIn.id]: MODEL_PORTS.toolsIn.kind,
        [MODEL_PORTS.skillsIn.id]: MODEL_PORTS.skillsIn.kind,
        [MODEL_PORTS.workspaceIn.id]: MODEL_PORTS.workspaceIn.kind,
        [MODEL_PORTS.gatewayIn.id]: MODEL_PORTS.gatewayIn.kind,
        [MODEL_PORTS.modelIn.id]: MODEL_PORTS.modelIn.kind,
    },
    tool: {
        [TOOL_PORTS.toolOut.id]: TOOL_PORTS.toolOut.kind,
        [TOOL_PORTS.secretsIn.id]: TOOL_PORTS.secretsIn.kind,
    },
    tool_pack: {
        [TOOL_PACK_PORTS.toolOut.id]: TOOL_PACK_PORTS.toolOut.kind,
        [TOOL_PACK_PORTS.secretsIn.id]: TOOL_PACK_PORTS.secretsIn.kind,
    },
    skill: { [SKILL_PORTS.skillOut.id]: SKILL_PORTS.skillOut.kind },
    skill_pack: { [SKILL_PORTS.skillOut.id]: SKILL_PORTS.skillOut.kind },
    workspace: {
        [WORKSPACE_PORTS.workspaceOut.id]: WORKSPACE_PORTS.workspaceOut.kind,
    },
    secrets: {
        [SECRETS_PORTS.secretsOut.id]: SECRETS_PORTS.secretsOut.kind,
    },
    gateway: {
        [GATEWAY_PORTS.gatewayIn.id]: GATEWAY_PORTS.gatewayIn.kind,
        [GATEWAY_PORTS.gatewayOut.id]: GATEWAY_PORTS.gatewayOut.kind,
    },
    output: {
        [OUTPUT_PORTS.outputIn.id]: OUTPUT_PORTS.outputIn.kind,
        [OUTPUT_PORTS.resultOut.id]: OUTPUT_PORTS.resultOut.kind,
        [OUTPUT_PORTS.errorOut.id]: OUTPUT_PORTS.errorOut.kind,
    },
    debug_gateway: {
        [DEBUG_GATEWAY_PORTS.out.id]: DEBUG_GATEWAY_PORTS.out.kind,
        [DEBUG_GATEWAY_PORTS.in.id]: DEBUG_GATEWAY_PORTS.in.kind,
    },
    permission: {
        [PERMISSION_PORTS.toolsIn.id]: PERMISSION_PORTS.toolsIn.kind,
        [PERMISSION_PORTS.toolsOut.id]: PERMISSION_PORTS.toolsOut.kind,
    },
    checkpoint: {
        [CHECKPOINT_PORTS.handlerOut.id]: CHECKPOINT_PORTS.handlerOut.kind,
    },
};

export function portKindL1(
    nodeType: Node['type'],
    portId: string | null | undefined,
): PortKind | null {
    if (!portId) return null;
    return L1_PORT_KIND[nodeType]?.[portId] ?? null;
}
