import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Edge, Node, Palette } from '@fabritorio/types';
import { palette as runnerPalette } from '../../runner/src/graphs/palette';
import { __setCachedPaletteForTest, paletteAllowedNodeTypes } from '../lib/palette';
import { canConnectToolPack } from '../lib/edge-validation';
import { validateForCompositeKind } from '../lib/save-selection';
import { classifyLibraryEntry, hiddenFragmentRefIds } from '../lib/node-factory';
import type { Fragment } from '../lib/subgraph';

beforeEach(() => {
    __setCachedPaletteForTest(null);
});

afterEach(() => {
    __setCachedPaletteForTest(runnerPalette);
});

function makePalette(overrides: Partial<Palette> = {}): Palette {
    return {
        version: 1,
        nodes: {},
        connections: {},
        compositeKinds: {
            toolpack: { allowedNodeTypes: ['tool'] },
        },
        ...overrides,
    };
}

describe('paletteAllowedNodeTypes', () => {
    it('returns null when the palette is not loaded', () => {
        expect(paletteAllowedNodeTypes('toolpack')).toBeNull();
    });

    it('returns the cached palette set once loaded', () => {
        __setCachedPaletteForTest(makePalette());
        const set = paletteAllowedNodeTypes('toolpack');
        expect(set).not.toBeNull();
        expect(set?.has('tool')).toBe(true);
        expect(set?.has('tool_pack')).toBe(false);
    });
});

describe('save-selection consumes the palette', () => {
    const toolNode: Node = {
        id: 'tool-1',
        type: 'tool',
        position: { x: 0, y: 0 },
        tool_name: 'shell',
    };
    const toolPackNode: Node = {
        id: 'tool_pack-1',
        type: 'tool_pack',
        position: { x: 0, y: 0 },
        ref_id: 'tp',
    };
    const frag = (nodes: Node[], edges: Edge[] = []): Fragment => ({
        kind: 'toolpack',
        nodes,
        edges,
    });

    it('falls back to the local mirror when no palette is cached', () => {
        const result = validateForCompositeKind(frag([toolNode, toolPackNode]), 'toolpack');
        expect(result.ok).toBe(true);
    });

    it('honours the cached palette when it narrows the allowlist', () => {
        __setCachedPaletteForTest(makePalette());
        const result = validateForCompositeKind(frag([toolNode, toolPackNode]), 'toolpack');
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/tool_pack/);
    });
});

describe('classifyLibraryEntry — fragment presets (Bug 1)', () => {
    const handler: Node = {
        id: 'h-1',
        type: 'handler',
        position: { x: 0, y: 0 },
    } as Node;
    const gateway: Node = {
        id: 'gw-1',
        type: 'gateway',
        position: { x: 0, y: 0 },
    } as Node;
    const l1Fragment = { kind: 'l1' as const, nodes: [handler, gateway], fragment: true };

    it('does NOT offer a fragment:true l1 entry on an l2 canvas', () => {
        expect(classifyLibraryEntry(l1Fragment, 'l2')).toBeNull();
    });

    it('offers a fragment:true l1 entry inline on an l1 canvas', () => {
        expect(classifyLibraryEntry(l1Fragment, 'l1')).toEqual({ kind: 'inline-multi' });
    });

    it('a fragment is never classified as wrapper or leaf', () => {
        const single = { kind: 'l1' as const, nodes: [handler], fragment: true };
        expect(classifyLibraryEntry(single, 'l1')).toEqual({ kind: 'inline-multi' });
        expect(classifyLibraryEntry(single, 'l2')).toBeNull();
    });

    it('a complete composite (no fragment flag) keeps cross-kind wrapper drop', () => {
        const composite = { kind: 'l1' as const, nodes: [handler, gateway] };
        expect(classifyLibraryEntry(composite, 'l2')).toEqual({
            kind: 'wrapper',
            savedKind: 'l1',
        });
    });
});

describe('hiddenFragmentRefIds — palette closure (Bug A)', () => {
    const coderL1 = { id: 'coder-l1', nodes: [] as Node[] };
    const composite = {
        id: 'composite-l2',
        nodes: [
            {
                id: 'agent-1',
                type: 'native_agent',
                position: { x: 0, y: 0 },
                l1_graph_id: 'coder-l1',
            } as Node,
        ],
    };

    it('a seed agent referenced by a NON-fragment composite is NOT hidden', () => {
        const hidden = hiddenFragmentRefIds([composite, coderL1]);
        expect(hidden.has('coder-l1')).toBe(false);
    });

    it('hides a frozen copy referenced (transitively) by a fragment:true preset', () => {
        const frozenToolpack = { id: 'frozen-tp', nodes: [] as Node[] };
        const frozenL1 = {
            id: 'frozen-l1',
            nodes: [
                {
                    id: 'tp-ref',
                    type: 'tool_pack',
                    position: { x: 0, y: 0 },
                    ref_id: 'frozen-tp',
                } as Node,
            ],
        };
        const fragmentPreset = {
            id: 'frag-preset',
            fragment: true,
            nodes: [
                {
                    id: 'agent-1',
                    type: 'native_agent',
                    position: { x: 0, y: 0 },
                    l1_graph_id: 'frozen-l1',
                } as Node,
            ],
        };
        const hidden = hiddenFragmentRefIds([
            fragmentPreset,
            frozenL1,
            frozenToolpack,
            composite,
            coderL1,
        ]);
        expect(hidden.has('frozen-l1')).toBe(true);
        expect(hidden.has('frozen-tp')).toBe(true);
        expect(hidden.has('frag-preset')).toBe(false);
        expect(hidden.has('coder-l1')).toBe(false);
    });
});

describe('edge-validation consumes the palette', () => {
    const toolNode: Node = {
        id: 'tool-1',
        type: 'tool',
        position: { x: 0, y: 0 },
        tool_name: 'shell',
    };
    const toolPackNode: Node = {
        id: 'tool_pack-1',
        type: 'tool_pack',
        position: { x: 0, y: 0 },
        ref_id: 'tp',
    };

    it('uses the palette to gate canConnectToolPack', () => {
        __setCachedPaletteForTest(makePalette());
        const res = canConnectToolPack([toolNode, toolPackNode], 'tool-1', 'tool_pack-1');
        expect(res.ok).toBe(false);
    });
});
