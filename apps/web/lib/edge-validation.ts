import type { GraphKind, Node, NodeType } from '@fabritorio/types';
import { defaultInPortL1, defaultOutPortL1, portKindL1 } from './ports';
import {
    findConnectionRule,
    findRuleBySource,
    findRuleByTarget,
    paletteAllowedNodeTypes,
} from './palette';

const FALLBACK_TOOLPACK_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(['tool', 'tool_pack']);
const FALLBACK_SKILLPACK_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(['skill', 'skill_pack']);
const FALLBACK_HANDLER_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
    'handler_input',
    'handler_output',
    'prompt_builder',
    'model_call',
    'tool_exec',
    'evaluator',
]);
const FALLBACK_CLI_INVOCATION_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
    'model',
    'workspace',
    'skill',
    'skill_pack',
    'cli_invocation_target',
]);
const FALLBACK_L2_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
    'channel',
    'trigger',
    'native_agent',
    'cli_agent',
    'pi_agent',
    'go_claude_agent',
    'memory',
    'debug_gateway',
    'debug_probe',
]);

function allowedTypesFor(kind: GraphKind, fallback: ReadonlySet<NodeType>): ReadonlySet<NodeType> {
    return paletteAllowedNodeTypes(kind) ?? fallback;
}

export interface EdgeCheck {
    ok: boolean;
    reason?: string;
    decorative?: boolean;
}

function humaniseType(type: NodeType): string {
    switch (type) {
        case 'tool_pack':
            return 'Tool Pack';
        case 'skill_pack':
            return 'Skill Pack';
        case 'model_router':
            return 'Model Router';
        case 'debug_gateway':
            return 'Debug Gateway';
        case 'debug_probe':
            return 'Debug Probe';
        case 'native_agent':
            return 'NativeAgent';
        case 'cli_agent':
            return 'CliAgent';
        case 'pi_agent':
            return 'PiAgent';
        case 'go_claude_agent':
            return 'GoClaudeAgent';
        case 'handler_input':
            return 'Handler Input';
        case 'handler_output':
            return 'Handler Output';
        case 'prompt_builder':
            return 'Prompt Builder';
        case 'model_call':
            return 'Model Call';
        case 'tool_exec':
            return 'Tool Exec';
        case 'cli_invocation_target':
            return 'CLI Agent Target';
        default: {
            return type[0]!.toUpperCase() + type.slice(1);
        }
    }
}

function rejectMessage(kind: GraphKind, sourceType: NodeType, targetType: NodeType): string {
    const sourceRule = findRuleBySource(kind, sourceType);
    if (sourceRule?.errorMessage) return sourceRule.errorMessage;
    const targetRule = findRuleByTarget(kind, targetType);
    if (!targetRule) {
        return `${humaniseType(targetType)} nodes have no inbound connections`;
    }
    if (!sourceRule) {
        return `${humaniseType(sourceType)} nodes have no outbound connections`;
    }
    return `${humaniseType(sourceType)} → ${humaniseType(targetType)} is not a legal wire on this canvas`;
}

export function probeAttachCheck(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
): EdgeCheck {
    if (sourceId === targetId) return { ok: false, reason: 'self-loop' };
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown node' };
    if (source.type !== 'debug_probe') return { ok: false, reason: 'not a probe attach' };
    if (target.type === 'debug_probe') {
        return { ok: false, reason: "probes can't probe other probes" };
    }
    for (const n of nodes) {
        if (n.type !== 'debug_probe') continue;
        if (n.id === sourceId) continue;
        if (n.attachedTo === targetId) {
            return {
                ok: false,
                reason: `another probe (${n.id}) is already attached to ${targetId}`,
            };
        }
    }
    return { ok: true, decorative: true };
}

function checkByPalette(kind: GraphKind, sourceType: NodeType, targetType: NodeType): EdgeCheck {
    const rule = findConnectionRule(kind, sourceType, targetType);
    if (rule) {
        return rule.decorative ? { ok: true, decorative: true } : { ok: true };
    }
    return { ok: false, reason: rejectMessage(kind, sourceType, targetType) };
}

export function canConnectL2(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
    sourcePortId?: string | null,
    targetPortId?: string | null,
): EdgeCheck {
    if (sourceId === targetId) return { ok: false, reason: 'self-loop' };
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown node' };

    if (source.type === 'debug_probe') {
        return probeAttachCheck(nodes, sourceId, targetId);
    }
    if (target.type === 'debug_probe') {
        return { ok: false, reason: 'Debug Probe has no inbound connections' };
    }

    const allowed = allowedTypesFor('l2', FALLBACK_L2_TYPES);
    if (!allowed.has(source.type) || !allowed.has(target.type)) {
        return {
            ok: false,
            reason: "L1 nodes belong inside a NativeAgent's sub-graph",
        };
    }

    void sourcePortId;
    void targetPortId;

    return checkByPalette('l2', source.type, target.type);
}

export function validateL2Graph(
    nodes: ReadonlyArray<Node>,
    edges: ReadonlyArray<{ source: { node_id: string }; target: { node_id: string } }>,
): string[] {
    const issues: string[] = [];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    for (const e of edges) {
        const s = byId.get(e.source.node_id);
        const t = byId.get(e.target.node_id);
        if (!s || !t) continue;
        if (t.type === 'cli_agent' || t.type === 'pi_agent') {
            if (
                s.type === 'tool' ||
                s.type === 'tool_pack' ||
                s.type === 'model' ||
                s.type === 'handler'
            ) {
                const agentLabel = t.type === 'cli_agent' ? 'CliAgent' : 'PiAgent';
                issues.push(
                    `${s.type} cannot attach to ${agentLabel} ${t.id} — wrap it in a NativeAgent instead`,
                );
            }
        }
    }

    return issues;
}

export function canConnectToolPack(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
): EdgeCheck {
    if (sourceId === targetId) return { ok: false, reason: 'self-loop' };
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown node' };
    const allowed = allowedTypesFor('toolpack', FALLBACK_TOOLPACK_TYPES);
    if (!allowed.has(source.type) || !allowed.has(target.type)) {
        return {
            ok: false,
            reason: 'Tool pack only accepts Tool or Tool Pack nodes',
        };
    }
    return checkByPalette('toolpack', source.type, target.type);
}

export function canConnectSkillPack(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
): EdgeCheck {
    if (sourceId === targetId) return { ok: false, reason: 'self-loop' };
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown node' };
    const allowed = allowedTypesFor('skillpack', FALLBACK_SKILLPACK_TYPES);
    if (!allowed.has(source.type) || !allowed.has(target.type)) {
        return {
            ok: false,
            reason: 'Skill pack only accepts Skill or Skill Pack nodes',
        };
    }
    return checkByPalette('skillpack', source.type, target.type);
}

export function canConnectCliInvocation(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
): EdgeCheck {
    if (sourceId === targetId) return { ok: false, reason: 'self-loop' };
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown node' };
    const allowed = allowedTypesFor('cli_invocation', FALLBACK_CLI_INVOCATION_TYPES);
    if (!allowed.has(source.type) || !allowed.has(target.type)) {
        return {
            ok: false,
            reason: 'CLI config only accepts Model / Workspace / Skill / Skill Pack / Agent Target',
        };
    }
    return checkByPalette('cli_invocation', source.type, target.type);
}

export function canConnectHandler(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
): EdgeCheck {
    if (sourceId === targetId) return { ok: false, reason: 'self-loop' };
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown node' };

    if (source.type === 'debug_probe') {
        return probeAttachCheck(nodes, sourceId, targetId);
    }
    if (target.type === 'debug_probe') {
        return { ok: false, reason: 'Debug Probe has no inbound connections' };
    }

    const allowed = allowedTypesFor('handler', FALLBACK_HANDLER_TYPES);
    if (!allowed.has(source.type) || !allowed.has(target.type)) {
        return {
            ok: false,
            reason: 'Handler graph only accepts handler primitive nodes',
        };
    }
    if (target.type === 'handler_input') {
        return { ok: false, reason: 'Handler Input has no inbound connections' };
    }
    if (source.type === 'handler_output') {
        return { ok: false, reason: 'Handler Output has no outbound connections' };
    }
    return checkByPalette('handler', source.type, target.type);
}

export function validateL1Graph(nodes: ReadonlyArray<Node>): string[] {
    const issues: string[] = [];
    const gateways = nodes.filter((n) => n.type === 'gateway');
    const outputs = nodes.filter((n) => n.type === 'output');
    if (gateways.length === 0) {
        issues.push('L1 graph needs a Gateway (single entrance)');
    } else if (gateways.length > 1) {
        issues.push('L1 graph allows only one Gateway');
    }
    if (outputs.length === 0) {
        issues.push('L1 graph needs an Output (sole exit)');
    }
    return issues;
}

export function canConnect(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
    sourcePortId?: string | null,
    targetPortId?: string | null,
): EdgeCheck {
    if (sourceId === targetId) return { ok: false, reason: 'self-loop' };
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown node' };

    if (source.type === 'debug_probe') {
        return probeAttachCheck(nodes, sourceId, targetId);
    }
    if (target.type === 'debug_probe') {
        return { ok: false, reason: 'Debug Probe has no inbound connections' };
    }

    if (sourcePortId && targetPortId) {
        const sk = portKindL1(source.type, sourcePortId);
        const tk = portKindL1(target.type, targetPortId);
        if (sk && tk && sk !== tk) {
            return {
                ok: false,
                reason: `${sk} source can't connect to ${tk} target`,
            };
        }
    }

    return checkByPalette('l1', source.type, target.type);
}

export function resolvePortsL1(
    nodes: ReadonlyArray<Node>,
    sourceId: string,
    targetId: string,
    sourcePortId?: string | null,
    targetPortId?: string | null,
): { source_port?: string; target_port?: string } {
    const source = nodes.find((n) => n.id === sourceId);
    const target = nodes.find((n) => n.id === targetId);
    if (!source || !target) return {};

    const sp = sourcePortId ?? defaultOutPortL1(source.type, target.type);
    const tp = targetPortId ?? defaultInPortL1(source.type, target.type);
    return {
        ...(sp ? { source_port: sp } : {}),
        ...(tp ? { target_port: tp } : {}),
    };
}
