import type { Graph } from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';

export const DEFAULT_SIMPLE_HANDLER_ID = '00000000-0000-4000-8000-000000000001';

export function buildDefaultSimpleHandlerGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'handler',
        name: 'Default SimpleHandler',
        description:
            'Shipped ReAct handler graph: prompt_builder → model_call → evaluator (loops to tool_exec or exits to handler_output).',
        library: true,
        nodes: [
            { id: 'h-in', type: 'handler_input', position: { x: 80, y: 200 } },
            {
                id: 'prompt-builder',
                type: 'prompt_builder',
                position: { x: 240, y: 200 },
            },
            { id: 'model-call', type: 'model_call', position: { x: 420, y: 200 } },
            { id: 'evaluator', type: 'evaluator', position: { x: 600, y: 200 } },
            { id: 'tool-exec', type: 'tool_exec', position: { x: 600, y: 360 } },
            {
                id: 'h-out',
                type: 'handler_output',
                position: { x: 800, y: 200 },
            },
        ],
        edges: [
            {
                id: 'h-in->prompt-builder',
                source: { node_id: 'h-in' },
                target: { node_id: 'prompt-builder' },
            },
            {
                id: 'prompt-builder->model-call',
                source: { node_id: 'prompt-builder' },
                target: { node_id: 'model-call' },
            },
            {
                id: 'model-call->evaluator',
                source: { node_id: 'model-call' },
                target: { node_id: 'evaluator' },
            },
            {
                id: 'evaluator-tools->tool-exec',
                source: { node_id: 'evaluator', port_id: 'tools' },
                target: { node_id: 'tool-exec' },
            },
            {
                id: 'tool-exec->model-call',
                source: { node_id: 'tool-exec' },
                target: { node_id: 'model-call' },
            },
            {
                id: 'evaluator-done->h-out',
                source: { node_id: 'evaluator', port_id: 'done' },
                target: { node_id: 'h-out' },
            },
        ],
    };
}

export async function seedDefaultHandlerGraph(store: GraphStore): Promise<Graph> {
    return store.seed(DEFAULT_SIMPLE_HANDLER_ID, buildDefaultSimpleHandlerGraph());
}
