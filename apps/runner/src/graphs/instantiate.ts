import type { Edge, Graph, GraphKind, Node } from '@fabritorio/types';
import { ensureAllAgentSidecars } from './sidecar.js';
import type { GraphStore } from './store.js';

export interface InstantiateResult {
    copy: Graph;
    remap: Map<string, string>;
}

export async function instantiateLibraryGraph(
    store: GraphStore,
    templateId: string,
): Promise<InstantiateResult> {
    const template = await store.get(templateId);
    if (!template) {
        throw new Error(`instantiate: template graph ${templateId} not found`);
    }
    if (template.library !== true) {
        throw new Error(
            `instantiate: graph ${templateId} is not a library template (library !== true)`,
        );
    }
    return cloneGraphTree(store, templateId);
}

export async function cloneGraphTree(
    store: GraphStore,
    sourceId: string,
    options: CloneOptions = {},
): Promise<InstantiateResult> {
    const source = await store.get(sourceId);
    if (!source) {
        throw new Error(`clone: source graph ${sourceId} not found`);
    }
    const remap = new Map<string, string>();
    const copy = await instantiateRecursive(store, sourceId, remap, options);
    return { copy, remap };
}

export interface CloneOptions {
    markLibrary?: boolean;
}

async function instantiateRecursive(
    store: GraphStore,
    templateId: string,
    remap: Map<string, string>,
    options: CloneOptions = {},
): Promise<Graph> {
    const existing = remap.get(templateId);
    if (existing) {
        const reread = await store.get(existing);
        if (!reread) {
            throw new Error(
                `instantiate: previously copied graph ${existing} disappeared from store`,
            );
        }
        return reread;
    }

    const template = await store.get(templateId);
    if (!template) {
        throw new Error(`instantiate: template graph ${templateId} not found`);
    }

    remap.set(templateId, IN_PROGRESS);

    const rewrittenNodes: Node[] = [];
    for (const node of template.nodes) {
        rewrittenNodes.push(await rewriteRefsInNode(store, node, remap, options));
    }
    const { nodes: newNodes, edges: newEdges } = freshenGraphContents({
        nodes: rewrittenNodes,
        edges: template.edges,
    });

    const withSidecars = ensureAllAgentSidecars({
        kind: template.kind as GraphKind,
        nodes: newNodes,
        edges: newEdges,
    });

    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: template.kind,
        nodes: withSidecars.nodes,
        edges: withSidecars.edges,
        ...(template.name ? { name: template.name } : {}),
        ...(template.description ? { description: template.description } : {}),
        ...(options.markLibrary ? { library: true } : {}),
    };
    const persisted = await store.create(draft);
    remap.set(templateId, persisted.id!);
    return persisted;
}

export function freshenGraphContents(input: { nodes: readonly Node[]; edges: readonly Edge[] }): {
    nodes: Node[];
    edges: Edge[];
    idRemap: Record<string, string>;
} {
    const nodeRemap = new Map<string, string>();
    const idRemap: Record<string, string> = {};
    const nodes: Node[] = input.nodes.map((node) => {
        const newId = freshNodeId(node.id);
        nodeRemap.set(node.id, newId);
        idRemap[node.id] = newId;
        return { ...node, id: newId };
    });
    const edges: Edge[] = input.edges.map((edge) => {
        const newId = freshEdgeId(edge.id);
        idRemap[edge.id] = newId;
        return {
            ...edge,
            id: newId,
            source: {
                ...edge.source,
                node_id: nodeRemap.get(edge.source.node_id) ?? edge.source.node_id,
            },
            target: {
                ...edge.target,
                node_id: nodeRemap.get(edge.target.node_id) ?? edge.target.node_id,
            },
        };
    });
    return { nodes, edges, idRemap };
}

export async function cloneSubtreeFragment(
    store: GraphStore,
    fragment: { nodes: readonly Node[]; edges: readonly Edge[] },
): Promise<{ nodes: Node[]; edges: Edge[]; remap: Record<string, string> }> {
    const refRemap = new Map<string, string>();

    const droppedSidecarIds = new Set<string>();
    for (const node of fragment.nodes) {
        if (node.type === 'channel' && node.owner_node_id) {
            droppedSidecarIds.add(node.id);
        }
    }
    const incomingNodes =
        droppedSidecarIds.size === 0
            ? fragment.nodes
            : fragment.nodes.filter((n) => !droppedSidecarIds.has(n.id));
    const incomingEdges =
        droppedSidecarIds.size === 0
            ? fragment.edges
            : fragment.edges.filter(
                  (e) =>
                      !droppedSidecarIds.has(e.source.node_id) &&
                      !droppedSidecarIds.has(e.target.node_id),
              );

    const rewrittenNodes: Node[] = [];
    for (const node of incomingNodes) {
        rewrittenNodes.push(await rewriteRefsInNode(store, node, refRemap));
    }
    const freshened = freshenGraphContents({ nodes: rewrittenNodes, edges: incomingEdges });

    const freshenedNodes = freshened.nodes.map((node) => {
        if (node.type !== 'debug_probe' || !node.attachedTo) return node;
        const remapped = freshened.idRemap[node.attachedTo];
        return { ...node, attachedTo: remapped } as Node;
    });

    const withSidecars = ensureAllAgentSidecars({
        kind: 'l2' as GraphKind,
        nodes: freshenedNodes,
        edges: freshened.edges,
    });
    const remap: Record<string, string> = { ...freshened.idRemap };
    for (const [oldRefId, newRefId] of refRemap.entries()) {
        if (newRefId === IN_PROGRESS) continue;
        remap[oldRefId] = newRefId;
    }
    return { nodes: withSidecars.nodes, edges: withSidecars.edges, remap };
}

const IN_PROGRESS = '__in_progress__';

export async function rewriteRefsInNode(
    store: GraphStore,
    node: Node,
    remap: Map<string, string>,
    options: CloneOptions = {},
): Promise<Node> {
    if (node.type === 'native_agent' && node.l1_graph_id) {
        const newRef = await maybeInstantiate(store, node.l1_graph_id, remap, options);
        if (newRef) {
            return { ...node, l1_graph_id: newRef };
        }
        return node;
    }
    if ('ref_id' in node && typeof node.ref_id === 'string' && node.ref_id) {
        const newRef = await maybeInstantiate(store, node.ref_id, remap, options);
        if (newRef) {
            return { ...node, ref_id: newRef };
        }
    }
    return node;
}

async function maybeInstantiate(
    store: GraphStore,
    refId: string,
    remap: Map<string, string>,
    options: CloneOptions = {},
): Promise<string | null> {
    const cached = remap.get(refId);
    if (cached && cached !== IN_PROGRESS) return cached;
    if (cached === IN_PROGRESS) {
        return null;
    }
    const target = await store.get(refId);
    if (!target) {
        return null;
    }
    const copy = await instantiateRecursive(store, refId, remap, options);
    return copy.id ?? null;
}

function freshNodeId(originalId: string): string {
    return `${originalId}__${shortToken()}`;
}

function freshEdgeId(originalId: string): string {
    return `${originalId}__${shortToken()}`;
}

function shortToken(): string {
    return Math.random().toString(36).slice(2, 8);
}
