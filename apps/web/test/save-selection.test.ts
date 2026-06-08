import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@fabritorio/types';
import type { Fragment } from '../lib/subgraph';
import { centroidOf, validateForCompositeKind } from '../lib/save-selection';

function frag(kind: Fragment['kind'], nodes: Node[], edges: Edge[] = []): Fragment {
    return { kind, nodes, edges };
}

describe('validateForCompositeKind — toolpack', () => {
    it('passes for two tool nodes with no edges', () => {
        const a: Node = {
            id: 'tool-1',
            type: 'tool',
            position: { x: 0, y: 0 },
            tool_name: 'shell',
        };
        const b: Node = {
            id: 'tool-2',
            type: 'tool',
            position: { x: 100, y: 0 },
            tool_name: 'edit',
        };
        const result = validateForCompositeKind(frag('toolpack', [a, b]), 'toolpack');
        expect(result.ok).toBe(true);
    });

    it('fails when the selection includes a gateway', () => {
        const tool: Node = {
            id: 'tool-1',
            type: 'tool',
            position: { x: 0, y: 0 },
            tool_name: 'shell',
        };
        const gateway: Node = {
            id: 'gateway-1',
            type: 'gateway',
            position: { x: 100, y: 0 },
        };
        const result = validateForCompositeKind(frag('l1', [tool, gateway]), 'toolpack');
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/gateway/);
    });
});

describe('validateForCompositeKind — handler', () => {
    it('passes with all six handler primitives wired up', () => {
        const input: Node = {
            id: 'h-in-1',
            type: 'handler_input',
            position: { x: 0, y: 0 },
        };
        const prompt: Node = {
            id: 'prompt-1',
            type: 'prompt_builder',
            position: { x: 100, y: 0 },
        };
        const model: Node = {
            id: 'model-call-1',
            type: 'model_call',
            position: { x: 200, y: 0 },
        };
        const tool: Node = {
            id: 'tool-exec-1',
            type: 'tool_exec',
            position: { x: 300, y: 0 },
        };
        const evaluator: Node = {
            id: 'eval-1',
            type: 'evaluator',
            position: { x: 400, y: 0 },
        };
        const out: Node = {
            id: 'h-out-1',
            type: 'handler_output',
            position: { x: 500, y: 0 },
        };
        const edges: Edge[] = [
            {
                id: 'h-in-1->prompt-1',
                source: { node_id: 'h-in-1' },
                target: { node_id: 'prompt-1' },
            },
            {
                id: 'prompt-1->model-call-1',
                source: { node_id: 'prompt-1' },
                target: { node_id: 'model-call-1' },
            },
            {
                id: 'model-call-1->tool-exec-1',
                source: { node_id: 'model-call-1' },
                target: { node_id: 'tool-exec-1' },
            },
            {
                id: 'tool-exec-1->eval-1',
                source: { node_id: 'tool-exec-1' },
                target: { node_id: 'eval-1' },
            },
            {
                id: 'eval-1->h-out-1',
                source: { node_id: 'eval-1' },
                target: { node_id: 'h-out-1' },
            },
        ];
        const result = validateForCompositeKind(
            frag('handler', [input, prompt, model, tool, evaluator, out], edges),
            'handler',
        );
        expect(result.ok).toBe(true);
    });

    it('fails with a stray tool node', () => {
        const input: Node = {
            id: 'h-in-1',
            type: 'handler_input',
            position: { x: 0, y: 0 },
        };
        const stray: Node = {
            id: 'tool-1',
            type: 'tool',
            position: { x: 100, y: 0 },
            tool_name: 'shell',
        };
        const result = validateForCompositeKind(frag('l1', [input, stray]), 'handler');
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/tool/);
    });
});

describe('validateForCompositeKind — l1', () => {
    it('fails with two gateways (folds in validateL1Graph)', () => {
        const g1: Node = {
            id: 'gateway-1',
            type: 'gateway',
            position: { x: 0, y: 0 },
        };
        const g2: Node = {
            id: 'gateway-2',
            type: 'gateway',
            position: { x: 100, y: 0 },
        };
        const result = validateForCompositeKind(frag('l1', [g1, g2]), 'l1');
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/only one Gateway/);
    });

    it('passes for an L1-typed selection without structural completeness', () => {
        const tool: Node = {
            id: 'tool-1',
            type: 'tool',
            position: { x: 0, y: 0 },
            tool_name: 'shell',
        };
        const model: Node = {
            id: 'model-1',
            type: 'model',
            position: { x: 100, y: 0 },
            provider: 'openai',
            model_id: 'gpt-4o-mini',
        };
        const result = validateForCompositeKind(frag('l1', [tool, model]), 'l1');
        expect(result.ok).toBe(true);
    });
});

describe('validateForCompositeKind — empty', () => {
    it('rejects an empty selection', () => {
        const result = validateForCompositeKind(frag('l1', []), 'toolpack');
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/[Nn]othing/);
    });
});

describe('centroidOf', () => {
    it('computes the mean position', () => {
        const a: Node = {
            id: 'tool-1',
            type: 'tool',
            position: { x: 0, y: 0 },
            tool_name: '',
        };
        const b: Node = {
            id: 'tool-2',
            type: 'tool',
            position: { x: 100, y: 200 },
            tool_name: '',
        };
        expect(centroidOf([a, b])).toEqual({ x: 50, y: 100 });
    });

    it('returns the origin for an empty input', () => {
        expect(centroidOf([])).toEqual({ x: 0, y: 0 });
    });
});
