import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Edge, Node } from '@fabritorio/types';
import { createGraphStore } from '../../src/graphs/store.js';
import { cloneSubtreeFragment } from '../../src/graphs/instantiate.js';

describe('cloneSubtreeFragment sidecar de-dup', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-clonesub-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('drops an incoming owner-stamped channel and mints exactly one fresh sidecar', async () => {
        const store = createGraphStore({ dir });
        const agent: Node = {
            id: 'agent-1',
            type: 'native_agent',
            position: { x: 0, y: 0 },
        };
        const staleSidecar: Node = {
            id: 'chan-stale',
            type: 'channel',
            channel_kind: 'webchat',
            owner_node_id: 'agent-1',
            position: { x: 240, y: 0 },
        };
        const edges: Edge[] = [
            { id: 'e-in', source: { node_id: 'chan-stale' }, target: { node_id: 'agent-1' } },
            { id: 'e-out', source: { node_id: 'agent-1' }, target: { node_id: 'chan-stale' } },
        ];

        const result = await cloneSubtreeFragment(store, {
            nodes: [agent, staleSidecar],
            edges,
        });

        const agents = result.nodes.filter((n) => n.type === 'native_agent');
        expect(agents).toHaveLength(1);
        const freshAgentId = agents[0]!.id;

        const sidecars = result.nodes.filter((n) => n.type === 'channel');
        expect(sidecars).toHaveLength(1);
        expect((sidecars[0] as { owner_node_id?: string }).owner_node_id).toBe(freshAgentId);

        const nodeIds = new Set(result.nodes.map((n) => n.id));
        for (const e of result.edges) {
            expect(nodeIds.has(e.source.node_id)).toBe(true);
            expect(nodeIds.has(e.target.node_id)).toBe(true);
        }
        const sidecarId = sidecars[0]!.id;
        for (const e of result.edges) {
            const touchesSidecar = e.source.node_id === sidecarId || e.target.node_id === sidecarId;
            const touchesAgent =
                e.source.node_id === freshAgentId || e.target.node_id === freshAgentId;
            expect(touchesSidecar && touchesAgent).toBe(true);
        }
        expect(result.edges).toHaveLength(2);
    });

    it('a fragment without sidecars is unaffected (still mints one per agent)', async () => {
        const store = createGraphStore({ dir });
        const agent: Node = { id: 'agent-1', type: 'native_agent', position: { x: 0, y: 0 } };
        const result = await cloneSubtreeFragment(store, { nodes: [agent], edges: [] });
        expect(result.nodes.filter((n) => n.type === 'native_agent')).toHaveLength(1);
        expect(result.nodes.filter((n) => n.type === 'channel')).toHaveLength(1);
    });
});

describe('cloneSubtreeFragment debug_probe.attachedTo remap', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-clonesub-probe-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('rewrites attachedTo to the pasted target id when the target is in the fragment', async () => {
        const store = createGraphStore({ dir });
        const handler: Node = { id: 'handler-1', type: 'handler', position: { x: 0, y: 0 } };
        const probe: Node = {
            id: 'probe-1',
            type: 'debug_probe',
            position: { x: 100, y: 0 },
            attachedTo: 'handler-1',
            haltOn: 'pre',
        } as Node;

        const result = await cloneSubtreeFragment(store, {
            nodes: [handler, probe],
            edges: [],
        });

        const pastedHandler = result.nodes.find((n) => n.type === 'handler')!;
        const pastedProbe = result.nodes.find((n) => n.type === 'debug_probe') as Node & {
            attachedTo?: string;
        };
        expect(pastedProbe.attachedTo).toBe(pastedHandler.id);
        expect(pastedProbe.attachedTo).not.toBe('handler-1');
    });

    it('clears attachedTo when the probe is pasted without its target', async () => {
        const store = createGraphStore({ dir });
        const probe: Node = {
            id: 'probe-1',
            type: 'debug_probe',
            position: { x: 0, y: 0 },
            attachedTo: 'handler-1',
            haltOn: 'pre',
        } as Node;

        const result = await cloneSubtreeFragment(store, { nodes: [probe], edges: [] });

        const pastedProbe = result.nodes.find((n) => n.type === 'debug_probe') as Node & {
            attachedTo?: string;
        };
        expect(pastedProbe.attachedTo).toBeUndefined();
    });
});
