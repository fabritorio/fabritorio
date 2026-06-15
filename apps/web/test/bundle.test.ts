import { describe, expect, it, vi } from 'vitest';
import type { Graph, Node } from '@fabritorio/types';
import {
    collectBundle,
    installBundle,
    isBundle,
    parseBundleText,
    type Bundle,
} from '../lib/bundle';
import type { GraphDraft, GraphSummary, RunnerClient } from '../lib/runner-client';

function summary(graph: Graph): GraphSummary {
    return {
        id: graph.id ?? '',
        graph,
        status: 'idle',
        liveness: 'idle',
        created_at: '',
        updated_at: '',
    };
}

function buildStubClient(seed: Graph[] = []) {
    const store = new Map<string, Graph>();
    for (const g of seed) {
        if (g.id) store.set(g.id, g);
    }
    let nextId = 1000;
    const mintId = () => `new-${nextId++}`;
    const updates: Array<{ id: string; draft: GraphDraft }> = [];
    const client: RunnerClient = {
        baseUrl: 'http://stub',
        async getHealth() {
            throw new Error('unused');
        },
        async createGraph(draft) {
            const id = mintId();
            const graph: Graph = { ...draft, id, created_at: '', updated_at: '' };
            store.set(id, graph);
            return summary(graph);
        },
        async listGraphs() {
            return Array.from(store.values()).map(summary);
        },
        async getGraph(id) {
            const g = store.get(id);
            return g ? summary(g) : null;
        },
        async updateGraph(id, draft) {
            updates.push({ id, draft });
            const existing = store.get(id);
            if (!existing) return null;
            const merged: Graph = { ...draft, id, created_at: '', updated_at: '' };
            store.set(id, merged);
            return summary(merged);
        },
        async renameGraph() {
            throw new Error('unused');
        },
        async deleteGraph() {
            throw new Error('unused');
        },
        async instantiateGraph() {
            throw new Error('unused');
        },
        async createGraphFromStarter() {
            throw new Error('unused');
        },
        async cloneGraph() {
            throw new Error('unused');
        },
        async cloneSubtree() {
            throw new Error('unused');
        },
        async saveFragment() {
            throw new Error('unused');
        },
        async applyGraphOps() {
            throw new Error('unused');
        },
        async activateGraph() {
            throw new Error('unused');
        },
        async stopGraph() {
            throw new Error('unused');
        },
        async resumeGraph() {
            throw new Error('unused');
        },
        async stopDispatch() {
            throw new Error('unused');
        },
        async loadGraph() {
            throw new Error('unused');
        },
        async unloadGraph() {
            throw new Error('unused');
        },
        async introspectGraph() {
            throw new Error('unused');
        },
        async getParentContext() {
            throw new Error('unused');
        },
        graphStatusStream() {
            throw new Error('unused');
        },
        async channelSendMessage() {
            throw new Error('unused');
        },
        channelStream() {
            throw new Error('unused');
        },
        async channelReplay() {
            throw new Error('unused');
        },
        async agentConversations() {
            throw new Error('unused');
        },
        async deleteConversation() {
            throw new Error('unused');
        },
        async renameConversation() {
            throw new Error('unused');
        },
        async debugSendMessage() {
            throw new Error('unused');
        },
        debugStream() {
            throw new Error('unused');
        },
        async debugReplay() {
            throw new Error('unused');
        },
        async getMemory() {
            throw new Error('unused');
        },
        async setMemoryKey() {
            throw new Error('unused');
        },
        async deleteMemoryKey() {
            throw new Error('unused');
        },
        async getMemoryFile() {
            throw new Error('unused');
        },
        async putMemoryFile() {
            throw new Error('unused');
        },
        async deleteMemoryFile() {
            throw new Error('unused');
        },
        async listTools() {
            throw new Error('unused');
        },
        async listSkills() {
            throw new Error('unused');
        },
        async getSkill() {
            throw new Error('unused');
        },
        async saveSkill() {
            throw new Error('unused');
        },
        async triggerRuns() {
            throw new Error('unused');
        },
        async triggerRun() {
            throw new Error('unused');
        },
        async fireTrigger() {
            throw new Error('unused');
        },
        async agentCalls() {
            throw new Error('unused');
        },
        async agentCallDetail() {
            throw new Error('unused');
        },
        agentAsksStream() {
            throw new Error('unused');
        },
        dispatchStream() {
            throw new Error('unused');
        },
        observabilityStream() {
            throw new Error('unused');
        },
        async observabilityReplay() {
            throw new Error('unused');
        },
        animationStream() {
            throw new Error('unused');
        },
        async debugProbeState() {
            throw new Error('unused');
        },
        async debugProbeResume() {
            throw new Error('unused');
        },
        async debugProbeEnable() {
            throw new Error('unused');
        },
        async debugProbeDisable() {
            throw new Error('unused');
        },
        debugProbeStream() {
            throw new Error('unused');
        },
        async permissionGateState() {
            throw new Error('unused');
        },
        async permissionGateDecide() {
            throw new Error('unused');
        },
        permissionGateStream() {
            throw new Error('unused');
        },
        async rawFetch() {
            throw new Error('unused');
        },
    };
    return { client, store, updates };
}

function gw(id: string, x = 0): Node {
    return { id, type: 'gateway', position: { x, y: 0 } };
}

function handlerNode(id: string, refId?: string): Node {
    return {
        id,
        type: 'handler',
        position: { x: 100, y: 0 },
        ...(refId ? { ref_id: refId } : {}),
    };
}

function toolPackNode(id: string, refId?: string): Node {
    return {
        id,
        type: 'tool_pack',
        position: { x: 200, y: 0 },
        ...(refId ? { ref_id: refId } : {}),
    };
}

function nativeAgentNode(id: string, l1: string): Node {
    return {
        id,
        type: 'native_agent',
        position: { x: 300, y: 0 },
        l1_graph_id: l1,
    };
}

describe('parseBundleText / isBundle', () => {
    it('returns null for non-JSON', () => {
        expect(parseBundleText('not json')).toBeNull();
        expect(parseBundleText('')).toBeNull();
    });

    it('returns null for the wrong shape', () => {
        expect(parseBundleText(JSON.stringify({ foo: 'bar' }))).toBeNull();
        expect(
            parseBundleText(JSON.stringify({ fabritorio: 1, root_id: 'x', graphs: 'no' })),
        ).toBeNull();
        expect(
            parseBundleText(JSON.stringify({ fabritorio: 1, root_id: '', graphs: [] })),
        ).toBeNull();
    });

    it('returns null for the wrong version', () => {
        expect(
            parseBundleText(JSON.stringify({ fabritorio: 2, root_id: 'x', graphs: [] })),
        ).toBeNull();
    });

    it('accepts a well-formed bundle', () => {
        const bundle: Bundle = {
            fabritorio: 1,
            root_id: 'root',
            graphs: [{ id: 'root', kind: 'l1', nodes: [], edges: [] }],
        };
        const parsed = parseBundleText(JSON.stringify(bundle));
        expect(parsed).not.toBeNull();
        expect(parsed!.root_id).toBe('root');
        expect(parsed!.graphs.length).toBe(1);
    });

    it('isBundle agrees with parseBundleText on valid input', () => {
        const ok = { fabritorio: 1, root_id: 'x', graphs: [] };
        expect(isBundle(ok)).toBe(true);
        expect(isBundle(null)).toBe(false);
        expect(isBundle({ fabritorio: 1, root_id: 'x' })).toBe(false);
    });
});

describe('collectBundle', () => {
    it('walks ref_id and l1_graph_id fields and dedupes', async () => {
        const handlerL0: Graph = {
            id: 'handler-X',
            kind: 'handler',
            nodes: [],
            edges: [],
        };
        const toolPack: Graph = {
            id: 'tp-1',
            kind: 'toolpack',
            nodes: [],
            edges: [],
        };
        const l1A: Graph = {
            id: 'l1-A',
            kind: 'l1',
            nodes: [gw('g'), handlerNode('h', 'handler-X'), toolPackNode('tp', 'tp-1')],
            edges: [],
        };
        const l2Root: Graph = {
            id: 'l2-root',
            kind: 'l2',
            nodes: [nativeAgentNode('agent-1', 'l1-A'), nativeAgentNode('agent-2', 'l1-A')],
            edges: [],
        };
        const { client } = buildStubClient([l2Root, l1A, handlerL0, toolPack]);
        const bundle = await collectBundle(client, 'l2-root');
        expect(bundle.fabritorio).toBe(1);
        expect(bundle.root_id).toBe('l2-root');
        expect(bundle.graphs[0]?.id).toBe('l2-root');
        const ids = bundle.graphs.map((g) => g.id).sort();
        expect(ids).toEqual(['handler-X', 'l1-A', 'l2-root', 'tp-1']);
    });

    it('skips missing graphs and continues', async () => {
        const root: Graph = {
            id: 'root',
            kind: 'l1',
            nodes: [handlerNode('h', 'missing-id')],
            edges: [],
        };
        const { client } = buildStubClient([root]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bundle = await collectBundle(client, 'root');
        expect(bundle.graphs.map((g) => g.id)).toEqual(['root']);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('terminates on cycles', async () => {
        const a: Graph = {
            id: 'a',
            kind: 'l1',
            nodes: [handlerNode('h', 'b')],
            edges: [],
        };
        const b: Graph = {
            id: 'b',
            kind: 'l1',
            nodes: [handlerNode('h', 'a')],
            edges: [],
        };
        const { client } = buildStubClient([a, b]);
        const bundle = await collectBundle(client, 'a');
        expect(bundle.graphs.map((g) => g.id).sort()).toEqual(['a', 'b']);
    });
});

describe('installBundle', () => {
    it('rewrites refs across the bundle using the id map', async () => {
        const handlerL0: Graph = {
            id: 'handler-X',
            kind: 'handler',
            nodes: [],
            edges: [],
        };
        const tp: Graph = { id: 'tp-1', kind: 'toolpack', nodes: [], edges: [] };
        const l1: Graph = {
            id: 'l1-A',
            kind: 'l1',
            nodes: [gw('g'), handlerNode('h', 'handler-X'), toolPackNode('tp', 'tp-1')],
            edges: [],
        };
        const l2: Graph = {
            id: 'l2-root',
            kind: 'l2',
            name: 'orig',
            nodes: [nativeAgentNode('agent-1', 'l1-A')],
            edges: [],
        };
        const bundle: Bundle = {
            fabritorio: 1,
            root_id: 'l2-root',
            graphs: [l2, l1, handlerL0, tp],
        };
        const { client, store, updates } = buildStubClient();
        const { rootId } = await installBundle(client, bundle);
        expect(rootId.startsWith('new-')).toBe(true);
        const storedRoot = store.get(rootId)!;
        const agent = storedRoot.nodes.find((n) => n.type === 'native_agent');
        expect(agent && 'l1_graph_id' in agent ? agent.l1_graph_id : '').not.toBe('l1-A');
        const newL1Id = (agent as { l1_graph_id: string }).l1_graph_id;
        const storedL1 = store.get(newL1Id)!;
        const handler = storedL1.nodes.find((n) => n.type === 'handler') as
            | (Node & { ref_id?: string })
            | undefined;
        const pack = storedL1.nodes.find((n) => n.type === 'tool_pack') as
            | (Node & { ref_id?: string })
            | undefined;
        expect(handler?.ref_id).toBeDefined();
        expect(handler?.ref_id).not.toBe('handler-X');
        expect(pack?.ref_id).not.toBe('tp-1');
        expect(updates.length).toBe(4);
    });

    it('applies the root name suffix only to the root', async () => {
        const child: Graph = {
            id: 'child',
            kind: 'handler',
            name: 'child-name',
            nodes: [],
            edges: [],
        };
        const root: Graph = {
            id: 'root',
            kind: 'l1',
            name: 'root-name',
            nodes: [handlerNode('h', 'child')],
            edges: [],
        };
        const bundle: Bundle = {
            fabritorio: 1,
            root_id: 'root',
            graphs: [root, child],
        };
        const { client, store } = buildStubClient();
        const { rootId } = await installBundle(client, bundle, {
            rootNameSuffix: ' (imported)',
        });
        const newRoot = store.get(rootId)!;
        expect(newRoot.name).toBe('root-name (imported)');
        const childGraphs = Array.from(store.values()).filter((g) => g.kind === 'handler');
        expect(childGraphs.length).toBe(1);
        expect(childGraphs[0]?.name).toBe('child-name');
    });

    it('throws when root_id is not in graphs', async () => {
        const bundle: Bundle = {
            fabritorio: 1,
            root_id: 'missing',
            graphs: [{ id: 'other', kind: 'l1', nodes: [], edges: [] }],
        };
        const { client } = buildStubClient();
        await expect(installBundle(client, bundle)).rejects.toThrow(/root_id/);
    });

    it('leaves refs that point outside the bundle untouched', async () => {
        const root: Graph = {
            id: 'root',
            kind: 'l1',
            nodes: [handlerNode('h', 'external-id')],
            edges: [],
        };
        const bundle: Bundle = {
            fabritorio: 1,
            root_id: 'root',
            graphs: [root],
        };
        const { client, store } = buildStubClient();
        const { rootId } = await installBundle(client, bundle);
        const stored = store.get(rootId)!;
        const handler = stored.nodes.find((n) => n.type === 'handler') as
            | (Node & { ref_id?: string })
            | undefined;
        expect(handler?.ref_id).toBe('external-id');
    });
});
