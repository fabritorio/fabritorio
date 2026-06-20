import type { Edge, Graph, GraphKind, Node, NodeType, Position } from '@fabritorio/types';
import { applyNodeDefaults } from './defaults.js';
import { isAgentType, refOf } from './invariant.js';
import { findConnectionRule, palette } from './palette.js';
import { ensureAgentSidecar } from './sidecar.js';
import type { GraphStore } from './store.js';

export type Op = AddNodeOp | AddEdgeOp | UpdateNodeConfigOp | DeleteNodeOp | DeleteEdgeOp;

export interface AddNodeOp {
    op: 'add_node';
    kind: NodeType;
    config?: Record<string, unknown>;
    position?: Position;
    as?: string;
}

export interface AddEdgeOp {
    op: 'add_edge';
    source: string;
    target: string;
    source_port?: string;
    target_port?: string;
    topic?: string;
    priority?: number;
}

export interface UpdateNodeConfigOp {
    op: 'update_node_config';
    id: string;
    patch: Record<string, unknown>;
}

export interface DeleteNodeOp {
    op: 'delete_node';
    id: string;
}

export interface DeleteEdgeOp {
    op: 'delete_edge';
    id: string;
}

export type OpResult =
    | { op: 'add_node'; ok: true; node: Node }
    | { op: 'add_edge'; ok: true; edge: Edge }
    | { op: 'update_node_config'; ok: true; node: Node }
    | {
          op: 'delete_node';
          ok: true;
          id: string;
          cascadedEdgeIds: string[];
          cascadedNodeIds: string[];
          orphanedRefId: string | null;
      }
    | { op: 'delete_edge'; ok: true; id: string }
    | OpFailure;

export interface OpFailure {
    ok: false;
    op: Op['op'];
    index: number;
    code:
        | 'unknown_op'
        | 'unknown_kind'
        | 'invalid_position'
        | 'unknown_node'
        | 'unknown_edge'
        | 'illegal_wire'
        | 'self_loop'
        | 'placeholder_unresolved';
    message: string;
}

export type ApplyOpsResult =
    | {
          ok: true;
          draft: Pick<Graph, 'kind' | 'nodes' | 'edges' | 'name' | 'description' | 'library'>;
          results: OpResult[];
          placeholderRemap: Record<string, string>;
      }
    | { ok: false; failure: OpFailure };

function isKnownNodeKind(kind: string): kind is NodeType {
    return Object.prototype.hasOwnProperty.call(palette.nodes, kind);
}

function isPlaceholder(s: string): boolean {
    return s.startsWith('$');
}

const NODE_PREFIX: Record<string, string> = {
    gateway: 'gateway',
    output: 'output',
    handler: 'handler',
    model: 'model',
    model_router: 'model-router',
    tool: 'tool',
    tool_pack: 'pack',
    skill: 'skill',
    skill_pack: 'skill-pack',
    workspace: 'workspace',
    channel: 'channel',
    trigger: 'trigger',
    native_agent: 'agent',
    memory: 'memory',
    handler_input: 'h-in',
    handler_output: 'h-out',
    prompt_builder: 'prompt',
    model_call: 'model-call',
    tool_exec: 'tool-exec',
    evaluator: 'eval',
    debug_gateway: 'debug',
    debug_probe: 'probe',
    permission: 'perm',
};

function shortToken(): string {
    return Math.random().toString(36).slice(2, 8);
}

export function mintNodeId(type: NodeType, taken: Set<string>): string {
    const prefix = NODE_PREFIX[type] ?? type;
    for (let i = 0; i < 16; i += 1) {
        const candidate = `${prefix}-${shortToken()}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${prefix}-${shortToken()}${shortToken()}`;
}

export function mintEdgeId(taken: Set<string>): string {
    for (let i = 0; i < 16; i += 1) {
        const candidate = `edge-${shortToken()}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `edge-${shortToken()}${shortToken()}`;
}

export function applyOps(base: Graph, ops: Op[]): ApplyOpsResult {
    const nodes: Node[] = base.nodes.map((n) => ({ ...n }));
    const edges: Edge[] = base.edges.map((e) => ({ ...e }));
    const results: OpResult[] = [];
    const placeholderRemap: Record<string, string> = {};

    const nodeIds = new Set<string>(nodes.map((n) => n.id));
    const edgeIds = new Set<string>(edges.map((e) => e.id));

    function fail(op: Op, index: number, code: OpFailure['code'], message: string): ApplyOpsResult {
        return { ok: false, failure: { ok: false, op: op.op, index, code, message } };
    }

    function resolveRef(s: string): string | null {
        if (!isPlaceholder(s)) return s;
        return placeholderRemap[s] ?? null;
    }

    for (let i = 0; i < ops.length; i += 1) {
        const op = ops[i]!;
        switch (op.op) {
            case 'add_node': {
                if (!isKnownNodeKind(op.kind)) {
                    return fail(op, i, 'unknown_kind', `unknown node kind '${op.kind}'`);
                }
                const config: Record<string, unknown> = { ...op.config };
                const position = op.position ?? { x: 0, y: 0 };
                if (
                    typeof position.x !== 'number' ||
                    typeof position.y !== 'number' ||
                    Number.isNaN(position.x) ||
                    Number.isNaN(position.y)
                ) {
                    return fail(
                        op,
                        i,
                        'invalid_position',
                        'position.x and position.y must be numbers',
                    );
                }
                const id = mintNodeId(op.kind, nodeIds);
                nodeIds.add(id);
                const rawNode = {
                    id,
                    type: op.kind,
                    position,
                    ...config,
                } as Node;
                const node = applyNodeDefaults(rawNode);
                nodes.push(node);
                if (op.as && isPlaceholder(op.as)) {
                    placeholderRemap[op.as] = id;
                }
                results.push({ op: 'add_node', ok: true, node });

                if (isAgentType(op.kind)) {
                    const sidecar = ensureAgentSidecar(
                        node,
                        base.kind as GraphKind,
                        nodes,
                        nodeIds,
                        edgeIds,
                    );
                    if (sidecar) {
                        nodes.push(sidecar.node);
                        results.push({ op: 'add_node', ok: true, node: sidecar.node });
                        for (const edge of sidecar.edges) {
                            edges.push(edge);
                            results.push({ op: 'add_edge', ok: true, edge });
                        }
                    }
                }
                break;
            }

            case 'add_edge': {
                const sourceId = resolveRef(op.source);
                const targetId = resolveRef(op.target);
                if (sourceId === null) {
                    return fail(
                        op,
                        i,
                        'placeholder_unresolved',
                        `add_edge source placeholder '${op.source}' has no matching add_node in this batch`,
                    );
                }
                if (targetId === null) {
                    return fail(
                        op,
                        i,
                        'placeholder_unresolved',
                        `add_edge target placeholder '${op.target}' has no matching add_node in this batch`,
                    );
                }
                if (sourceId === targetId) {
                    return fail(op, i, 'self_loop', `add_edge self-loop on node ${sourceId}`);
                }
                const sourceNode = nodes.find((n) => n.id === sourceId);
                if (!sourceNode) {
                    return fail(
                        op,
                        i,
                        'unknown_node',
                        `add_edge source '${sourceId}' is not a node in this graph`,
                    );
                }
                const targetNode = nodes.find((n) => n.id === targetId);
                if (!targetNode) {
                    return fail(
                        op,
                        i,
                        'unknown_node',
                        `add_edge target '${targetId}' is not a node in this graph`,
                    );
                }
                const rule = findConnectionRule(
                    base.kind as GraphKind,
                    sourceNode.type,
                    targetNode.type,
                );
                if (!rule) {
                    return fail(
                        op,
                        i,
                        'illegal_wire',
                        `${sourceNode.type} → ${targetNode.type} is not a legal wire on graph kind '${base.kind}'`,
                    );
                }
                const sourcePort = op.source_port ?? rule.sourcePort;
                const targetPort = op.target_port ?? rule.targetPort;
                const id = mintEdgeId(edgeIds);
                edgeIds.add(id);
                const edge: Edge = {
                    id,
                    source: {
                        node_id: sourceId,
                        ...(sourcePort ? { port_id: sourcePort } : {}),
                    },
                    target: {
                        node_id: targetId,
                        ...(targetPort ? { port_id: targetPort } : {}),
                    },
                    ...(op.topic ? { topic: op.topic } : {}),
                    ...(typeof op.priority === 'number' ? { priority: op.priority } : {}),
                };
                edges.push(edge);
                results.push({ op: 'add_edge', ok: true, edge });
                break;
            }

            case 'update_node_config': {
                const idx = nodes.findIndex((n) => n.id === op.id);
                if (idx === -1) {
                    return fail(
                        op,
                        i,
                        'unknown_node',
                        `update_node_config: node '${op.id}' not found`,
                    );
                }
                const current = nodes[idx]!;
                const merged = {
                    ...current,
                    ...op.patch,
                    id: current.id,
                    type: current.type,
                    position: current.position,
                } as Node;
                const node = applyNodeDefaults(merged);
                nodes[idx] = node;
                results.push({ op: 'update_node_config', ok: true, node });
                break;
            }

            case 'delete_node': {
                const idx = nodes.findIndex((n) => n.id === op.id);
                if (idx === -1) {
                    return fail(op, i, 'unknown_node', `delete_node: node '${op.id}' not found`);
                }
                const orphanedRefId = refOf(nodes[idx]!);
                nodes.splice(idx, 1);
                const cascadedNodeIds: string[] = [];
                for (let j = nodes.length - 1; j >= 0; j -= 1) {
                    const n = nodes[j]!;
                    if (n.type === 'channel' && n.owner_node_id === op.id) {
                        cascadedNodeIds.push(n.id);
                        nodes.splice(j, 1);
                    }
                }
                const removedNodeIds = new Set<string>([op.id, ...cascadedNodeIds]);
                const cascadedEdgeIds: string[] = [];
                for (let j = edges.length - 1; j >= 0; j -= 1) {
                    const e = edges[j]!;
                    if (
                        removedNodeIds.has(e.source.node_id) ||
                        removedNodeIds.has(e.target.node_id)
                    ) {
                        cascadedEdgeIds.push(e.id);
                        edges.splice(j, 1);
                    }
                }
                results.push({
                    op: 'delete_node',
                    ok: true,
                    id: op.id,
                    cascadedEdgeIds,
                    cascadedNodeIds,
                    orphanedRefId,
                });
                break;
            }

            case 'delete_edge': {
                const idx = edges.findIndex((e) => e.id === op.id);
                if (idx === -1) {
                    return fail(op, i, 'unknown_edge', `delete_edge: edge '${op.id}' not found`);
                }
                edges.splice(idx, 1);
                results.push({ op: 'delete_edge', ok: true, id: op.id });
                break;
            }

            default: {
                const stray = op as { op: string };
                return {
                    ok: false,
                    failure: {
                        ok: false,
                        op: stray.op as Op['op'],
                        index: i,
                        code: 'unknown_op',
                        message: `unknown op '${stray.op}'`,
                    },
                };
            }
        }
    }

    return {
        ok: true,
        draft: {
            kind: base.kind,
            nodes,
            edges,
            ...(base.name !== undefined ? { name: base.name } : {}),
            ...(base.description !== undefined ? { description: base.description } : {}),
            ...(base.library !== undefined ? { library: base.library } : {}),
        },
        results,
        placeholderRemap,
    };
}

export type ParseOpsResult =
    | { ok: true; ops: Op[] }
    | { ok: false; index: number; message: string };

export function parseOps(raw: unknown): ParseOpsResult {
    if (!Array.isArray(raw)) {
        return { ok: false, index: -1, message: 'ops must be an array' };
    }
    const ops: Op[] = [];
    for (let i = 0; i < raw.length; i += 1) {
        const entry = raw[i];
        if (!entry || typeof entry !== 'object') {
            return { ok: false, index: i, message: 'op must be an object' };
        }
        const obj = entry as Record<string, unknown>;
        const kind = obj.op;
        if (typeof kind !== 'string') {
            return { ok: false, index: i, message: 'op.op must be a string' };
        }
        switch (kind) {
            case 'add_node': {
                if (typeof obj.kind !== 'string') {
                    return { ok: false, index: i, message: 'add_node.kind must be a string' };
                }
                const op: AddNodeOp = {
                    op: 'add_node',
                    kind: obj.kind as NodeType,
                    ...(obj.config && typeof obj.config === 'object'
                        ? { config: obj.config as Record<string, unknown> }
                        : {}),
                    ...(obj.position && typeof obj.position === 'object'
                        ? { position: obj.position as Position }
                        : {}),
                    ...(typeof obj.as === 'string' ? { as: obj.as } : {}),
                };
                ops.push(op);
                break;
            }
            case 'add_edge': {
                if (typeof obj.source !== 'string' || typeof obj.target !== 'string') {
                    return {
                        ok: false,
                        index: i,
                        message: 'add_edge.source and add_edge.target must be strings',
                    };
                }
                const op: AddEdgeOp = {
                    op: 'add_edge',
                    source: obj.source,
                    target: obj.target,
                    ...(typeof obj.source_port === 'string'
                        ? { source_port: obj.source_port }
                        : {}),
                    ...(typeof obj.target_port === 'string'
                        ? { target_port: obj.target_port }
                        : {}),
                    ...(typeof obj.topic === 'string' ? { topic: obj.topic } : {}),
                    ...(typeof obj.priority === 'number' ? { priority: obj.priority } : {}),
                };
                ops.push(op);
                break;
            }
            case 'update_node_config': {
                if (typeof obj.id !== 'string') {
                    return {
                        ok: false,
                        index: i,
                        message: 'update_node_config.id must be a string',
                    };
                }
                if (!obj.patch || typeof obj.patch !== 'object') {
                    return {
                        ok: false,
                        index: i,
                        message: 'update_node_config.patch must be an object',
                    };
                }
                const op: UpdateNodeConfigOp = {
                    op: 'update_node_config',
                    id: obj.id,
                    patch: obj.patch as Record<string, unknown>,
                };
                ops.push(op);
                break;
            }
            case 'delete_node': {
                if (typeof obj.id !== 'string') {
                    return { ok: false, index: i, message: 'delete_node.id must be a string' };
                }
                ops.push({ op: 'delete_node', id: obj.id });
                break;
            }
            case 'delete_edge': {
                if (typeof obj.id !== 'string') {
                    return { ok: false, index: i, message: 'delete_edge.id must be a string' };
                }
                ops.push({ op: 'delete_edge', id: obj.id });
                break;
            }
            default:
                return { ok: false, index: i, message: `unknown op '${kind}'` };
        }
    }
    return { ok: true, ops };
}

export async function loadAndApplyOps(
    store: GraphStore,
    graphId: string,
    ops: Op[],
): Promise<
    | { ok: true; base: Graph; result: ApplyOpsResult }
    | { ok: false; status: 404 | 400; message: string }
> {
    const base = await store.get(graphId);
    if (!base) {
        return { ok: false, status: 404, message: 'graph not found' };
    }
    const result = applyOps(base, ops);
    return { ok: true, base, result };
}
