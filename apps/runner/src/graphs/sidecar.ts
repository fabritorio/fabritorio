import type { ChannelNode, Edge, Graph, GraphKind, Node } from '@fabritorio/types';
import { applyNodeDefaults } from './defaults.js';
import { isAgentType } from './invariant.js';
import { mintEdgeId, mintNodeId } from './ops.js';
import { findConnectionRule } from './palette.js';

export const SIDECAR_X_OFFSET = 240;

export interface SidecarAdditions {
    node: ChannelNode;
    edges: Edge[];
}

export function ensureAgentSidecar(
    agent: Node,
    graphKind: GraphKind,
    existingNodes: ReadonlyArray<Node>,
    takenNodeIds: Set<string>,
    takenEdgeIds: Set<string>,
): SidecarAdditions | null {
    if (!isAgentType(agent.type)) return null;

    const alreadyOwned = existingNodes.some(
        (n) => n.type === 'channel' && n.owner_node_id === agent.id,
    );
    if (alreadyOwned) return null;

    const inboundRule = findConnectionRule(graphKind, 'channel', agent.type);
    if (!inboundRule) {
        throw new Error(
            `chat sidecar: no palette rule for channel → ${agent.type} on graph kind '${graphKind}' — palette-rule bug`,
        );
    }
    const replyRule = findConnectionRule(graphKind, agent.type, 'channel');
    if (!replyRule) {
        throw new Error(
            `chat sidecar: no palette rule for ${agent.type} → channel on graph kind '${graphKind}' — palette-rule bug`,
        );
    }

    const channelId = mintNodeId('channel', takenNodeIds);
    takenNodeIds.add(channelId);

    const rawChannel = {
        id: channelId,
        type: 'channel',
        channel_kind: 'webchat',
        owner_node_id: agent.id,
        position: { x: agent.position.x + SIDECAR_X_OFFSET, y: agent.position.y },
    } as ChannelNode;
    const node = applyNodeDefaults(rawChannel) as ChannelNode;

    const inboundEdgeId = mintEdgeId(takenEdgeIds);
    takenEdgeIds.add(inboundEdgeId);
    const replyEdgeId = mintEdgeId(takenEdgeIds);
    takenEdgeIds.add(replyEdgeId);

    const inboundEdge: Edge = {
        id: inboundEdgeId,
        source: {
            node_id: channelId,
            ...(inboundRule.sourcePort ? { port_id: inboundRule.sourcePort } : {}),
        },
        target: {
            node_id: agent.id,
            ...(inboundRule.targetPort ? { port_id: inboundRule.targetPort } : {}),
        },
    };
    const replyEdge: Edge = {
        id: replyEdgeId,
        source: {
            node_id: agent.id,
            ...(replyRule.sourcePort ? { port_id: replyRule.sourcePort } : {}),
        },
        target: {
            node_id: channelId,
            ...(replyRule.targetPort ? { port_id: replyRule.targetPort } : {}),
        },
    };

    return { node, edges: [inboundEdge, replyEdge] };
}

export function ensureAllAgentSidecars<G extends Pick<Graph, 'kind' | 'nodes' | 'edges'>>(
    graph: G,
): G {
    const takenNodeIds = new Set<string>(graph.nodes.map((n) => n.id));
    const takenEdgeIds = new Set<string>(graph.edges.map((e) => e.id));
    const addedNodes: Node[] = [];
    const addedEdges: Edge[] = [];

    const liveNodes: Node[] = [...graph.nodes];
    for (const node of graph.nodes) {
        if (!isAgentType(node.type)) continue;
        const additions = ensureAgentSidecar(
            node,
            graph.kind as GraphKind,
            liveNodes,
            takenNodeIds,
            takenEdgeIds,
        );
        if (!additions) continue;
        liveNodes.push(additions.node);
        addedNodes.push(additions.node);
        addedEdges.push(...additions.edges);
    }

    if (addedNodes.length === 0 && addedEdges.length === 0) return graph;
    return {
        ...graph,
        nodes: [...graph.nodes, ...addedNodes],
        edges: [...graph.edges, ...addedEdges],
    };
}
