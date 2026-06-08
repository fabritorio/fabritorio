import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Node } from '@fabritorio/types';
import {
    buildPastedGraph,
    parseClipboardFragment,
    serializeFragment,
    type CloneSubtreeFn,
} from '../lib/canvas-clipboard';
import { extractFragment } from '../lib/subgraph';

function l1Graph(nodes: Node[], edges: Edge[] = []): Graph {
    return { kind: 'l1', nodes, edges };
}

function emptyL1(): Graph {
    return { kind: 'l1', id: 'dest-1', nodes: [], edges: [] };
}

const gateway: Node = { id: 'gateway-1', type: 'gateway', position: { x: 0, y: 0 } };
const handler: Node = {
    id: 'handler-1',
    type: 'handler',
    position: { x: 100, y: 0 },
    max_iterations: 8,
};
const model: Node = {
    id: 'model-1',
    type: 'model',
    position: { x: 200, y: 0 },
    provider: 'openai',
    model_id: 'gpt-4o-mini',
};

const eGatewayHandler: Edge = {
    id: 'gateway-1->handler-1',
    source: { node_id: 'gateway-1', port_id: 'gateway-out' },
    target: { node_id: 'handler-1', port_id: 'handler-in' },
};
const eHandlerModel: Edge = {
    id: 'handler-1->model-1',
    source: { node_id: 'handler-1', port_id: 'handler-model' },
    target: { node_id: 'model-1', port_id: 'model-in' },
};

function fakeCloneSubtree(targetGraph: Graph, suffix = '__paste'): CloneSubtreeFn {
    return async (fragment) => {
        const idMap = new Map<string, string>();
        const remap: Record<string, string> = {};
        const fragmentNodeIds = new Set(fragment.nodes.map((n) => n.id));
        const freshNodes: Node[] = fragment.nodes.map((n) => {
            const newId = `${n.id}${suffix}`;
            idMap.set(n.id, newId);
            remap[n.id] = newId;
            return { ...n, id: newId };
        });
        const freshEdges: Edge[] = fragment.edges.map((e) => {
            const newId = `${e.id}${suffix}`;
            remap[e.id] = newId;
            return {
                ...e,
                id: newId,
                source: { ...e.source, node_id: idMap.get(e.source.node_id) ?? e.source.node_id },
                target: { ...e.target, node_id: idMap.get(e.target.node_id) ?? e.target.node_id },
            };
        });
        const rewrittenNodes = freshNodes.map((n) => {
            if (n.type !== 'debug_probe' || !n.attachedTo) return n;
            const targetWasInFragment = fragmentNodeIds.has(n.attachedTo);
            return {
                ...n,
                attachedTo: targetWasInFragment ? idMap.get(n.attachedTo) : undefined,
            } as Node;
        });
        const graph: Graph = {
            ...targetGraph,
            nodes: [...targetGraph.nodes, ...rewrittenNodes],
            edges: [...targetGraph.edges, ...freshEdges],
        };
        return { graph, remap };
    };
}

describe('parseClipboardFragment', () => {
    it('returns null for non-JSON text', () => {
        expect(parseClipboardFragment('not json at all')).toBeNull();
        expect(parseClipboardFragment('')).toBeNull();
    });

    it('returns null for JSON without the fabritorio marker', () => {
        expect(parseClipboardFragment(JSON.stringify({ foo: 'bar' }))).toBeNull();
        expect(
            parseClipboardFragment(JSON.stringify({ fabritorio: 2, kind: 'l1', fragment: {} })),
        ).toBeNull();
    });

    it('returns null for envelopes with a malformed fragment', () => {
        expect(
            parseClipboardFragment(JSON.stringify({ fabritorio: 1, kind: 'l1', fragment: null })),
        ).toBeNull();
        expect(
            parseClipboardFragment(
                JSON.stringify({
                    fabritorio: 1,
                    kind: 'l1',
                    fragment: { kind: 'l1', nodes: 'nope', edges: [] },
                }),
            ),
        ).toBeNull();
    });

    it('returns the carried fragment for valid envelopes', () => {
        const frag = extractFragment(l1Graph([gateway, handler], [eGatewayHandler]), [
            'gateway-1',
            'handler-1',
        ]);
        const text = serializeFragment(frag);
        const parsed = parseClipboardFragment(text);
        expect(parsed).not.toBeNull();
        expect(parsed?.kind).toBe('l1');
        expect(parsed?.nodes.length).toBe(2);
        expect(parsed?.edges.length).toBe(1);
    });
});

describe('buildPastedGraph (BE-owned)', () => {
    it('returns null when clipboard text is non-Fabritorio JSON', async () => {
        const target = emptyL1();
        const result = await buildPastedGraph(
            target,
            '{}',
            { x: 0, y: 0 },
            fakeCloneSubtree(target),
        );
        expect(result).toBeNull();
    });

    it("returns null when clipboard text isn't JSON at all", async () => {
        const target = emptyL1();
        const result = await buildPastedGraph(
            target,
            'hello world',
            { x: 0, y: 0 },
            fakeCloneSubtree(target),
        );
        expect(result).toBeNull();
    });

    it('adopts the canonical destination graph and reports the pasted node ids', async () => {
        const source = l1Graph([gateway, handler, model], [eGatewayHandler, eHandlerModel]);
        const frag = extractFragment(source, ['gateway-1', 'handler-1', 'model-1']);
        const text = serializeFragment(frag);
        const target = emptyL1();
        const result = await buildPastedGraph(
            target,
            text,
            { x: 24, y: 24 },
            fakeCloneSubtree(target),
        );
        expect(result).not.toBeNull();
        expect(result!.graph.nodes.length).toBe(3);
        expect(result!.graph.edges.length).toBe(2);
        expect(result!.addedNodeIds.length).toBe(3);
        const ids = new Set(result!.graph.nodes.map((n) => n.id));
        for (const id of result!.addedNodeIds) expect(ids.has(id)).toBe(true);
        for (const e of result!.graph.edges) {
            expect(ids.has(e.source.node_id)).toBe(true);
            expect(ids.has(e.target.node_id)).toBe(true);
        }
    });

    it('throws on kind mismatch (caller surfaces via setError)', async () => {
        const frag = extractFragment(l1Graph([gateway, handler], [eGatewayHandler]), [
            'gateway-1',
            'handler-1',
        ]);
        const text = serializeFragment(frag);
        const target: Graph = { kind: 'l2', id: 'dest-l2', nodes: [], edges: [] };
        await expect(
            buildPastedGraph(target, text, { x: 0, y: 0 }, fakeCloneSubtree(target)),
        ).rejects.toThrow(/kind mismatch/);
    });

    it('skips the round-trip when the fragment has no nodes', async () => {
        const frag = { kind: 'l1' as const, nodes: [] as Node[], edges: [] as Edge[] };
        const text = serializeFragment(frag);
        const target = emptyL1();
        let calls = 0;
        const result = await buildPastedGraph(target, text, { x: 0, y: 0 }, async () => {
            calls += 1;
            return { graph: target, remap: {} };
        });
        expect(calls).toBe(0);
        expect(result).not.toBeNull();
        expect(result!.addedNodeIds).toEqual([]);
    });

    it('bakes the paste offset into the fragment before sending (position-agnostic route)', async () => {
        const source = l1Graph([gateway, handler], [eGatewayHandler]);
        const frag = extractFragment(source, ['gateway-1', 'handler-1']);
        const text = serializeFragment(frag);
        const target = emptyL1();
        const result = await buildPastedGraph(
            target,
            text,
            { x: 24, y: 24 },
            fakeCloneSubtree(target),
        );
        expect(result).not.toBeNull();
        const cmp = (a: number, b: number) => a - b;
        const originalXs = frag.nodes.map((n) => n.position.x).sort(cmp);
        const newXs = result!.graph.nodes.map((n) => n.position.x).sort(cmp);
        expect(newXs).toEqual(originalXs.map((x) => x + 24));
    });

    it('selection ids survive the BE-side remap (pasted nodes are selectable)', async () => {
        const source = l1Graph([gateway, handler], [eGatewayHandler]);
        const frag = extractFragment(source, ['gateway-1', 'handler-1']);
        const text = serializeFragment(frag);
        const target = emptyL1();
        const result = await buildPastedGraph(
            target,
            text,
            { x: 0, y: 0 },
            fakeCloneSubtree(target),
        );
        expect(result).not.toBeNull();
        expect(result!.addedNodeIds).toEqual(['gateway-1__paste', 'handler-1__paste']);
        const ids = new Set(result!.graph.nodes.map((n) => n.id));
        for (const id of result!.addedNodeIds) expect(ids.has(id)).toBe(true);
    });
});
