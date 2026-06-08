import { describe, it, expect } from 'vitest';
import type { Graph, Node, Edge } from '@fabritorio/types';
import { autoLayout } from '../../src/graphs/auto-layout.js';

const COLUMN_STRIDE = 240;
const ROW_STRIDE = 160;

function gatewayNode(id: string): Node {
    return { id, type: 'gateway', position: { x: 0, y: 0 } };
}

function handlerNode(id: string): Node {
    return { id, type: 'handler', position: { x: 0, y: 0 }, max_iterations: 8 };
}

function outputNode(id: string): Node {
    return { id, type: 'output', position: { x: 0, y: 0 } };
}

function modelNode(id: string): Node {
    return {
        id,
        type: 'model',
        position: { x: 0, y: 0 },
        provider: 'openai',
        model_id: 'gpt-4o-mini',
        auth_env: 'OPENAI_API_KEY',
        temperature: 0.3,
        system_prompt: 'sys',
    };
}

function edge(id: string, source: string, target: string): Edge {
    return { id, source: { node_id: source }, target: { node_id: target } };
}

describe('autoLayout', () => {
    it('lays out a linear chain across columns at row 0', () => {
        const graph: Graph = {
            kind: 'l1',
            nodes: [gatewayNode('a'), handlerNode('b'), outputNode('c')],
            edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
        };
        const out = autoLayout(graph);
        const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n.position]));
        expect(byId.a).toEqual({ x: 0, y: 0 });
        expect(byId.b).toEqual({ x: COLUMN_STRIDE, y: 0 });
        expect(byId.c).toEqual({ x: 2 * COLUMN_STRIDE, y: 0 });
    });

    it('places branching DAG successors at max(predecessor rank)+1 with row stacking', () => {
        const graph: Graph = {
            kind: 'l1',
            nodes: [gatewayNode('a'), handlerNode('b'), outputNode('c'), modelNode('d')],
            edges: [
                edge('e1', 'a', 'b'),
                edge('e2', 'a', 'c'),
                edge('e3', 'b', 'd'),
                edge('e4', 'c', 'd'),
            ],
        };
        const out = autoLayout(graph);
        const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n.position]));
        expect(byId.a).toEqual({ x: 0, y: 0 });
        expect(byId.d).toEqual({ x: 2 * COLUMN_STRIDE, y: 0 });
        expect(byId.b).toEqual({ x: COLUMN_STRIDE, y: 0 });
        expect(byId.c).toEqual({ x: COLUMN_STRIDE, y: ROW_STRIDE });
    });

    it('preserves user-set positions and only lays out nodes with default {0,0}', () => {
        const pinned: Node = {
            id: 'pinned',
            type: 'gateway',
            position: { x: 999, y: 777 },
        };
        const graph: Graph = {
            kind: 'l1',
            nodes: [pinned, handlerNode('b'), outputNode('c')],
            edges: [edge('e1', 'pinned', 'b'), edge('e2', 'b', 'c')],
        };
        const out = autoLayout(graph);
        const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n.position]));
        expect(byId.pinned).toEqual({ x: 999, y: 777 });
        expect(byId.b).toEqual({ x: COLUMN_STRIDE, y: 0 });
        expect(byId.c).toEqual({ x: 2 * COLUMN_STRIDE, y: 0 });
    });

    it('returns the empty graph unchanged', () => {
        const graph: Graph = { kind: 'l1', nodes: [], edges: [] };
        const out = autoLayout(graph);
        expect(out.nodes).toEqual([]);
        expect(out.edges).toEqual([]);
        expect(out.kind).toBe('l1');
    });

    it('does not crash on cyclic graphs and assigns finite positions to all nodes', () => {
        const graph: Graph = {
            kind: 'l1',
            nodes: [gatewayNode('a'), handlerNode('b'), outputNode('c')],
            edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
        };
        const out = autoLayout(graph);
        expect(out.nodes).toHaveLength(3);
        for (const n of out.nodes) {
            expect(Number.isFinite(n.position.x)).toBe(true);
            expect(Number.isFinite(n.position.y)).toBe(true);
        }
    });
});
