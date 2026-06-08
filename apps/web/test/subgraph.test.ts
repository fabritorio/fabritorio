import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Node } from '@fabritorio/types';
import { extractFragment } from '../lib/subgraph';

function l1Graph(nodes: Node[], edges: Edge[] = []): Graph {
    return { kind: 'l1', nodes, edges };
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
const tool: Node = {
    id: 'tool-1',
    type: 'tool',
    position: { x: 100, y: 100 },
    tool_name: 'fetch',
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
const eToolHandler: Edge = {
    id: 'tool-1->handler-1',
    source: { node_id: 'tool-1' },
    target: { node_id: 'handler-1' },
};

describe('extractFragment', () => {
    it('drops edges that cross the selection boundary', () => {
        const g = l1Graph(
            [gateway, handler, model, tool],
            [eGatewayHandler, eHandlerModel, eToolHandler],
        );
        const frag = extractFragment(g, ['handler-1', 'model-1']);
        expect(frag.kind).toBe('l1');
        expect(frag.nodes.map((n) => n.id).sort()).toEqual(['handler-1', 'model-1']);
        expect(frag.edges.map((e) => e.id)).toEqual(['handler-1->model-1']);
    });

    it('ignores selection ids absent from the graph', () => {
        const g = l1Graph([gateway, handler], [eGatewayHandler]);
        const frag = extractFragment(g, ['gateway-1', 'ghost-9']);
        expect(frag.nodes.map((n) => n.id)).toEqual(['gateway-1']);
        expect(frag.edges).toEqual([]);
    });

    it('accepts a Set or an Array for selection ids', () => {
        const g = l1Graph([gateway, handler], [eGatewayHandler]);
        const fromSet = extractFragment(g, new Set(['gateway-1', 'handler-1']));
        const fromArr = extractFragment(g, ['gateway-1', 'handler-1']);
        expect(fromSet.nodes.length).toBe(2);
        expect(fromArr.nodes.length).toBe(2);
        expect(fromSet.edges.length).toBe(1);
        expect(fromArr.edges.length).toBe(1);
    });
});
