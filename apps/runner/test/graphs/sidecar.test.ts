import type { Graph, NodeType } from '@fabritorio/types';
import { describe, expect, it } from 'vitest';
import { applyOps } from '../../src/graphs/ops.js';
import { ensureAgentSidecar, ensureAllAgentSidecars } from '../../src/graphs/sidecar.js';

const AGENT_TYPES: NodeType[] = ['native_agent'];

function emptyL2(): Graph {
    return { kind: 'l2', nodes: [], edges: [] };
}

describe('chat sidecar via applyOps', () => {
    for (const agentType of AGENT_TYPES) {
        it(`mints one owned channel + two wired edges for ${agentType}`, () => {
            const res = applyOps(emptyL2(), [
                { op: 'add_node', kind: agentType, position: { x: 100, y: 50 } },
            ]);
            expect(res.ok).toBe(true);
            if (!res.ok) return;

            const agent = res.draft.nodes.find((n) => n.type === agentType);
            expect(agent).toBeDefined();
            const agentId = agent!.id;

            const channels = res.draft.nodes.filter((n) => n.type === 'channel');
            expect(channels).toHaveLength(1);
            const channel = channels[0]!;
            expect(channel.type).toBe('channel');
            if (channel.type !== 'channel') return;
            expect(channel.owner_node_id).toBe(agentId);
            expect(channel.channel_kind).toBe('webchat');
            expect(Number.isNaN(channel.position.x)).toBe(false);
            expect(Number.isNaN(channel.position.y)).toBe(false);
            expect(channel.position.x).toBeGreaterThan(agent!.position.x);

            expect(res.draft.edges).toHaveLength(2);
            const inbound = res.draft.edges.find(
                (e) => e.source.node_id === channel.id && e.target.node_id === agentId,
            );
            const reply = res.draft.edges.find(
                (e) => e.source.node_id === agentId && e.target.node_id === channel.id,
            );
            expect(inbound).toBeDefined();
            expect(reply).toBeDefined();
            expect(inbound!.source.port_id).toBe('channel-out');
            expect(inbound!.target.port_id).toBe('agent-gateway-in');
            expect(reply!.source.port_id).toBe('agent-output-out');
            expect(reply!.target.port_id).toBe('channel-in');

            expect(res.results).toHaveLength(4);
            const addNodes = res.results.filter((r) => r.ok && r.op === 'add_node');
            const addEdges = res.results.filter((r) => r.ok && r.op === 'add_edge');
            expect(addNodes).toHaveLength(2);
            expect(addEdges).toHaveLength(2);
        });
    }

    it('mints no sidecar for a non-agent node (trigger)', () => {
        const res = applyOps(emptyL2(), [
            { op: 'add_node', kind: 'trigger', position: { x: 0, y: 0 } },
        ]);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.draft.nodes.filter((n) => n.type === 'channel')).toHaveLength(0);
        expect(res.draft.edges).toHaveLength(0);
        expect(res.results).toHaveLength(1);
    });

    it('mints no sidecar for a non-agent node (tool_pack)', () => {
        const res = applyOps(emptyL2(), [
            { op: 'add_node', kind: 'tool_pack', position: { x: 0, y: 0 } },
        ]);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.draft.nodes.filter((n) => n.type === 'channel')).toHaveLength(0);
        expect(res.results).toHaveLength(1);
    });

    it('cascade-deletes the sidecar channel + its edges, reporting both', () => {
        const created = applyOps(emptyL2(), [
            { op: 'add_node', kind: 'native_agent', position: { x: 0, y: 0 } },
        ]);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const agentId = created.draft.nodes.find((n) => n.type === 'native_agent')!.id;
        const channelId = created.draft.nodes.find((n) => n.type === 'channel')!.id;
        const base: Graph = {
            kind: 'l2',
            nodes: created.draft.nodes,
            edges: created.draft.edges,
        };

        const del = applyOps(base, [{ op: 'delete_node', id: agentId }]);
        expect(del.ok).toBe(true);
        if (!del.ok) return;

        expect(del.draft.nodes).toHaveLength(0);
        expect(del.draft.edges).toHaveLength(0);

        const result = del.results[0]!;
        expect(result.ok).toBe(true);
        if (!result.ok || result.op !== 'delete_node') return;
        expect(result.cascadedNodeIds).toContain(channelId);
        expect(result.cascadedEdgeIds).toHaveLength(2);
    });
});

describe('ensureAgentSidecar helper', () => {
    it('is idempotent — returns null when an owned channel already exists', () => {
        const agent = { id: 'agent-1', type: 'native_agent' as const, position: { x: 0, y: 0 } };
        const existing = {
            id: 'channel-1',
            type: 'channel' as const,
            channel_kind: 'webchat' as const,
            owner_node_id: 'agent-1',
            position: { x: 240, y: 0 },
        };
        const nodeIds = new Set(['agent-1', 'channel-1']);
        const edgeIds = new Set<string>();
        const out = ensureAgentSidecar(agent, 'l2', [agent, existing], nodeIds, edgeIds);
        expect(out).toBeNull();
    });

    it('returns null for a non-agent node', () => {
        const node = { id: 'trigger-1', type: 'trigger' as const, position: { x: 0, y: 0 } };
        const out = ensureAgentSidecar(node, 'l2', [node], new Set(['trigger-1']), new Set());
        expect(out).toBeNull();
    });

    it('mints a fresh sidecar for an agent with no owned channel', () => {
        const agent = { id: 'agent-1', type: 'native_agent' as const, position: { x: 10, y: 20 } };
        const out = ensureAgentSidecar(agent, 'l2', [agent], new Set(['agent-1']), new Set());
        expect(out).not.toBeNull();
        if (!out) return;
        expect(out.node.owner_node_id).toBe('agent-1');
        expect(out.edges).toHaveLength(2);
    });
});

describe('ensureAllAgentSidecars graph-level backfill', () => {
    it('mints one sidecar per agent, leaving a user-placed channel untouched', () => {
        const graph: Graph = {
            kind: 'l2',
            nodes: [
                {
                    id: 'user-channel',
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                { id: 'agent-1', type: 'native_agent', position: { x: 100, y: 0 } },
                { id: 'agent-2', type: 'native_agent', position: { x: 200, y: 0 } },
            ],
            edges: [],
        };
        const out = ensureAllAgentSidecars(graph);

        const channels = out.nodes.filter((n) => n.type === 'channel');
        expect(channels).toHaveLength(3);
        const userChannel = channels.find((c) => c.id === 'user-channel')!;
        expect(userChannel.type === 'channel' && userChannel.owner_node_id).toBeFalsy();
        const owned = channels.filter((c) => c.type === 'channel' && c.owner_node_id);
        expect(owned).toHaveLength(2);
        const owners = owned
            .map((c) => (c.type === 'channel' ? c.owner_node_id : undefined))
            .sort();
        expect(owners).toEqual(['agent-1', 'agent-2']);
        expect(out.edges).toHaveLength(4);
    });

    it('is idempotent — a second pass mints nothing', () => {
        const graph: Graph = {
            kind: 'l2',
            nodes: [{ id: 'agent-1', type: 'native_agent', position: { x: 0, y: 0 } }],
            edges: [],
        };
        const once = ensureAllAgentSidecars(graph);
        expect(once.nodes.filter((n) => n.type === 'channel')).toHaveLength(1);
        const twice = ensureAllAgentSidecars(once);
        expect(twice.nodes.filter((n) => n.type === 'channel')).toHaveLength(1);
        expect(twice.nodes).toHaveLength(once.nodes.length);
        expect(twice.edges).toHaveLength(once.edges.length);
    });

    it('returns an unchanged copy for a graph with no agents', () => {
        const graph: Graph = {
            kind: 'l2',
            nodes: [
                {
                    id: 'trigger-1',
                    type: 'trigger',
                    trigger_kind: 'manual',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        };
        const out = ensureAllAgentSidecars(graph);
        expect(out.nodes).toHaveLength(1);
        expect(out.edges).toHaveLength(0);
    });
});
