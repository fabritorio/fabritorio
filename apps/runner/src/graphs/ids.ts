import type { Edge, Graph, Node } from '@fabritorio/types';
import type { GraphStore } from './store.js';

export interface NormalizedIds {
    nodes: Node[];
    edges: Edge[];
    remap: Record<string, string>;
}

async function collectExistingNodeIds(
    store: GraphStore,
    excludeGraphId: string | undefined,
): Promise<Set<string>> {
    const all = await store.list();
    const ids = new Set<string>();
    for (const g of all) {
        if (excludeGraphId && g.id === excludeGraphId) continue;
        for (const n of g.nodes) ids.add(n.id);
    }
    return ids;
}

async function collectExistingEdgeIds(
    store: GraphStore,
    excludeGraphId: string | undefined,
): Promise<Set<string>> {
    const all = await store.list();
    const ids = new Set<string>();
    for (const g of all) {
        if (excludeGraphId && g.id === excludeGraphId) continue;
        for (const e of g.edges) ids.add(e.id);
    }
    return ids;
}

function shortToken(): string {
    return Math.random().toString(36).slice(2, 8);
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

function mintNodeId(type: string, taken: Set<string>): string {
    const prefix = NODE_PREFIX[type] ?? type;
    for (let i = 0; i < 16; i += 1) {
        const candidate = `${prefix}-${shortToken()}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${prefix}-${shortToken()}${shortToken()}`;
}

function mintEdgeId(taken: Set<string>): string {
    for (let i = 0; i < 16; i += 1) {
        const candidate = `edge-${shortToken()}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `edge-${shortToken()}${shortToken()}`;
}

export async function normalizeGraphIds(
    store: GraphStore,
    incoming: Pick<Graph, 'nodes' | 'edges'>,
    excludeGraphId: string | undefined,
): Promise<NormalizedIds> {
    const existingNodeIds = await collectExistingNodeIds(store, excludeGraphId);
    const existingEdgeIds = await collectExistingEdgeIds(store, excludeGraphId);

    const remap: Record<string, string> = {};
    const nodeIdsInUse = new Set<string>(existingNodeIds);
    const seenInPayload = new Set<string>();
    const newNodes: Node[] = [];

    for (const node of incoming.nodes) {
        const rawId = typeof node.id === 'string' ? node.id : '';
        const needsRewrite =
            rawId.length === 0 || existingNodeIds.has(rawId) || seenInPayload.has(rawId);
        if (!needsRewrite) {
            seenInPayload.add(rawId);
            nodeIdsInUse.add(rawId);
            newNodes.push(node);
            continue;
        }
        const fresh = mintNodeId(node.type, nodeIdsInUse);
        nodeIdsInUse.add(fresh);
        seenInPayload.add(fresh);
        if (rawId.length > 0) remap[rawId] = fresh;
        newNodes.push({ ...node, id: fresh });
    }

    const nodeRemap = new Map<string, string>();
    for (const [oldId, newId] of Object.entries(remap)) nodeRemap.set(oldId, newId);

    const edgeIdsInUse = new Set<string>(existingEdgeIds);
    const seenEdgeIds = new Set<string>();
    const newEdges: Edge[] = [];

    for (const edge of incoming.edges) {
        const rawId = typeof edge.id === 'string' ? edge.id : '';
        const needsRewrite =
            rawId.length === 0 || existingEdgeIds.has(rawId) || seenEdgeIds.has(rawId);
        const sourceNodeId = nodeRemap.get(edge.source.node_id) ?? edge.source.node_id;
        const targetNodeId = nodeRemap.get(edge.target.node_id) ?? edge.target.node_id;
        const rewriteEndpoints =
            sourceNodeId !== edge.source.node_id || targetNodeId !== edge.target.node_id;

        if (!needsRewrite && !rewriteEndpoints) {
            seenEdgeIds.add(rawId);
            edgeIdsInUse.add(rawId);
            newEdges.push(edge);
            continue;
        }

        let nextId = rawId;
        if (needsRewrite) {
            nextId = mintEdgeId(edgeIdsInUse);
            if (rawId.length > 0) remap[rawId] = nextId;
        }
        edgeIdsInUse.add(nextId);
        seenEdgeIds.add(nextId);

        newEdges.push({
            ...edge,
            id: nextId,
            source: { ...edge.source, node_id: sourceNodeId },
            target: { ...edge.target, node_id: targetNodeId },
        });
    }

    return { nodes: newNodes, edges: newEdges, remap };
}
