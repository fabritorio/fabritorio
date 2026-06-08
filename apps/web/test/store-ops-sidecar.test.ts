import { beforeEach, describe, expect, it } from 'vitest';
import type { Graph } from '@fabritorio/types';
import { useFabritorioStore } from '../lib/store';

const AGENT_ID = 'native_agent-1';
const SIDECAR_ID = 'channel-sidecar-1';

const canonicalGraph: Graph = {
    id: 'g-1',
    kind: 'l2',
    nodes: [
        { id: AGENT_ID, type: 'native_agent', position: { x: 0, y: 0 }, l1_graph_id: 'l1-x' },
        {
            id: SIDECAR_ID,
            type: 'channel',
            position: { x: 0, y: 0 },
            channel_kind: 'webchat',
            owner_node_id: AGENT_ID,
        },
    ],
    edges: [
        {
            id: `${SIDECAR_ID}->${AGENT_ID}`,
            source: { node_id: SIDECAR_ID },
            target: { node_id: AGENT_ID },
        },
        {
            id: `${AGENT_ID}->${SIDECAR_ID}`,
            source: { node_id: AGENT_ID },
            target: { node_id: SIDECAR_ID },
        },
    ],
};

describe('applyOpsResult adopts the canonical graph including the sidecar', () => {
    beforeEach(() => {
        useFabritorioStore.setState({
            graph: {
                id: 'g-1',
                kind: 'l2',
                nodes: [
                    {
                        id: 'opt-agent',
                        type: 'native_agent',
                        position: { x: 0, y: 0 },
                        l1_graph_id: 'l1-x',
                    },
                ],
                edges: [],
            },
            currentGraphId: 'g-1',
            selectedNodeId: 'opt-agent',
        });
    });

    it('lands the sidecar node and both wiring edges in the store', () => {
        useFabritorioStore.getState().applyOpsResult(canonicalGraph, { 'opt-agent': AGENT_ID });
        const { graph } = useFabritorioStore.getState();

        expect(graph.nodes.map((n) => n.id).sort()).toEqual([SIDECAR_ID, AGENT_ID].sort());
        const sidecar = graph.nodes.find((n) => n.id === SIDECAR_ID);
        expect(sidecar?.type).toBe('channel');
        expect((sidecar as { owner_node_id?: string }).owner_node_id).toBe(AGENT_ID);

        expect(graph.edges.map((e) => e.id).sort()).toEqual(
            [`${SIDECAR_ID}->${AGENT_ID}`, `${AGENT_ID}->${SIDECAR_ID}`].sort(),
        );
    });

    it('migrates the selection through the remap to the canonical agent id', () => {
        useFabritorioStore.getState().applyOpsResult(canonicalGraph, { 'opt-agent': AGENT_ID });
        expect(useFabritorioStore.getState().selectedNodeId).toBe(AGENT_ID);
    });
});
