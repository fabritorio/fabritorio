import type { GraphKind, Node, NodeType } from '@fabritorio/types';
import type { Fragment } from './subgraph';
import {
    canConnectHandler,
    canConnectSkillPack,
    canConnectToolPack,
    validateL1Graph,
} from './edge-validation';
import { paletteAllowedNodeTypes } from './palette';

export type CompositeKind = 'toolpack' | 'skillpack' | 'handler' | 'l1';

export interface ValidationResult {
    ok: boolean;
    reason?: string;
}

const FALLBACK_ALLOWED: Record<CompositeKind, ReadonlySet<NodeType>> = {
    toolpack: new Set<NodeType>(['tool', 'tool_pack']),
    skillpack: new Set<NodeType>(['skill', 'skill_pack']),
    handler: new Set<NodeType>([
        'handler_input',
        'handler_output',
        'prompt_builder',
        'model_call',
        'tool_exec',
        'evaluator',
    ]),
    l1: new Set<NodeType>([
        'gateway',
        'output',
        'handler',
        'model',
        'model_router',
        'tool',
        'tool_pack',
        'skill',
        'skill_pack',
        'workspace',
    ]),
};

function allowedTypesFor(kind: CompositeKind): ReadonlySet<NodeType> {
    const fromPalette = paletteAllowedNodeTypes(kind as GraphKind);
    return fromPalette ?? FALLBACK_ALLOWED[kind];
}

export function validateForCompositeKind(
    fragment: Fragment,
    compositeKind: CompositeKind,
): ValidationResult {
    if (fragment.nodes.length === 0) {
        return { ok: false, reason: 'Nothing selected to save.' };
    }
    switch (compositeKind) {
        case 'toolpack':
            return validateToolPack(fragment);
        case 'skillpack':
            return validateSkillPack(fragment);
        case 'handler':
            return validateHandler(fragment);
        case 'l1':
            return validateL1(fragment);
    }
}

function validateToolPack(fragment: Fragment): ValidationResult {
    const allowed = allowedTypesFor('toolpack');
    for (const n of fragment.nodes) {
        if (!allowed.has(n.type)) {
            return {
                ok: false,
                reason: `Selection contains a ${n.type} node — only Tool or Tool Pack nodes may be saved as a Tool Pack.`,
            };
        }
    }
    for (const e of fragment.edges) {
        const check = canConnectToolPack(fragment.nodes, e.source.node_id, e.target.node_id);
        if (!check.ok) {
            return {
                ok: false,
                reason: `Edge ${e.id} is invalid for a Tool Pack: ${check.reason ?? 'rejected'}.`,
            };
        }
    }
    return { ok: true };
}

function validateSkillPack(fragment: Fragment): ValidationResult {
    const allowed = allowedTypesFor('skillpack');
    for (const n of fragment.nodes) {
        if (!allowed.has(n.type)) {
            return {
                ok: false,
                reason: `Selection contains a ${n.type} node — only Skill or Skill Pack nodes may be saved as a Skill Pack.`,
            };
        }
    }
    for (const e of fragment.edges) {
        const check = canConnectSkillPack(fragment.nodes, e.source.node_id, e.target.node_id);
        if (!check.ok) {
            return {
                ok: false,
                reason: `Edge ${e.id} is invalid for a Skill Pack: ${check.reason ?? 'rejected'}.`,
            };
        }
    }
    return { ok: true };
}

function validateHandler(fragment: Fragment): ValidationResult {
    const allowed = allowedTypesFor('handler');
    for (const n of fragment.nodes) {
        if (!allowed.has(n.type)) {
            return {
                ok: false,
                reason: `Selection contains a ${n.type} node — only handler primitives may be saved as a Handler graph.`,
            };
        }
    }
    for (const e of fragment.edges) {
        const check = canConnectHandler(fragment.nodes, e.source.node_id, e.target.node_id);
        if (!check.ok) {
            return {
                ok: false,
                reason: `Edge ${e.id} is invalid for a Handler graph: ${check.reason ?? 'rejected'}.`,
            };
        }
    }
    return { ok: true };
}

function validateL1(fragment: Fragment): ValidationResult {
    const allowed = allowedTypesFor('l1');
    for (const n of fragment.nodes) {
        if (!allowed.has(n.type)) {
            return {
                ok: false,
                reason: `Selection contains a ${n.type} node — only L1 node types may be saved as an L1 graph.`,
            };
        }
    }
    const issues = validateL1Graph(fragment.nodes);
    const blocking = issues.filter((s) => s.includes('only one'));
    if (blocking.length > 0) {
        return { ok: false, reason: blocking[0] };
    }
    return { ok: true };
}

export function centroidOf(nodes: ReadonlyArray<Node>): { x: number; y: number } {
    if (nodes.length === 0) return { x: 0, y: 0 };
    let sx = 0;
    let sy = 0;
    for (const n of nodes) {
        sx += n.position.x;
        sy += n.position.y;
    }
    return { x: sx / nodes.length, y: sy / nodes.length };
}
