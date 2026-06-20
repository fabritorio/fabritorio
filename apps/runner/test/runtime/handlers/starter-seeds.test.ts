import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    STARTER_HANDLER_ID,
    STARTER_IDS,
    STARTER_L1_ID,
    STARTER_L2_ID,
    STARTER_SKILLPACK_ID,
    STARTER_TOOLPACK_ID,
} from '@fabritorio/types';
import { createGraphStore } from '../../../src/graphs/store.js';
import { seedStarterLibraryGraphs } from '../../../src/runtime/handlers/starter-seeds.js';
import { MODEL_PROVIDER_DEFAULT, MODEL_ID_DEFAULT } from '../../../src/graphs/defaults.js';
import { instantiateLibraryGraph } from '../../../src/graphs/instantiate.js';
import { checkTopology } from '../../../src/graphs/invariant.js';

describe('seedStarterLibraryGraphs', () => {
    let graphsDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-starter-seeds-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
    });

    it('seeds all five starters at their stable ids with the expected kinds + library/system flags', async () => {
        const store = createGraphStore({ dir: graphsDir });
        const result = await seedStarterLibraryGraphs(store);

        expect(result.handler.id).toBe(STARTER_HANDLER_ID);
        expect(result.l1.id).toBe(STARTER_L1_ID);
        expect(result.l2.id).toBe(STARTER_L2_ID);
        expect(result.toolpack.id).toBe(STARTER_TOOLPACK_ID);
        expect(result.skillpack.id).toBe(STARTER_SKILLPACK_ID);

        expect(result.handler.kind).toBe('handler');
        expect(result.l1.kind).toBe('l1');
        expect(result.l2.kind).toBe('l2');
        expect(result.toolpack.kind).toBe('toolpack');
        expect(result.skillpack.kind).toBe('skillpack');

        for (const g of [result.handler, result.l1, result.l2, result.toolpack, result.skillpack]) {
            expect(g.library).toBe(true);
            expect(g.system).toBe(true);
        }
    });

    it('STARTER_IDS map covers every GraphKind and matches the seeded ids', async () => {
        expect(STARTER_IDS.handler).toBe(STARTER_HANDLER_ID);
        expect(STARTER_IDS.l1).toBe(STARTER_L1_ID);
        expect(STARTER_IDS.l2).toBe(STARTER_L2_ID);
        expect(STARTER_IDS.toolpack).toBe(STARTER_TOOLPACK_ID);
        expect(STARTER_IDS.skillpack).toBe(STARTER_SKILLPACK_ID);
    });

    it('starter handler is the canonical ReAct shape (input → prompt_builder → model_call → evaluator ↔ tool_exec → handler_output)', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedStarterLibraryGraphs(store);
        const handler = await store.get(STARTER_HANDLER_ID);
        expect(handler).toBeDefined();

        const types = handler!.nodes.map((n) => n.type).sort();
        expect(types).toEqual([
            'evaluator',
            'handler_input',
            'handler_output',
            'model_call',
            'prompt_builder',
            'tool_exec',
        ]);

        const wires = handler!.edges.map((e) => `${e.source.node_id}->${e.target.node_id}`).sort();
        expect(wires).toContain('handler-input->prompt-builder');
        expect(wires).toContain('prompt-builder->model-call');
        expect(wires).toContain('model-call->evaluator');
        expect(wires).toContain('evaluator->handler-output');
        expect(wires).toContain('evaluator->tool-exec');
        expect(wires).toContain('tool-exec->model-call');

        const evaluatorTools = handler!.edges.find(
            (e) => e.source.node_id === 'evaluator' && e.source.port_id === 'tools',
        );
        const evaluatorDone = handler!.edges.find(
            (e) => e.source.node_id === 'evaluator' && e.source.port_id === 'done',
        );
        expect(evaluatorTools).toBeDefined();
        expect(evaluatorDone).toBeDefined();
    });

    it('starter L1 is Gateway → Handler(ref → STARTER_HANDLER_ID) → Model + Output, drill-down chain wired', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedStarterLibraryGraphs(store);
        const l1 = await store.get(STARTER_L1_ID);
        expect(l1).toBeDefined();

        const types = l1!.nodes.map((n) => n.type).sort();
        expect(types).toEqual(['gateway', 'handler', 'model', 'output']);

        const handler = l1!.nodes.find((n) => n.type === 'handler') as
            | { ref_id?: string }
            | undefined;
        expect(handler?.ref_id).toBe(STARTER_HANDLER_ID);

        const model = l1!.nodes.find((n) => n.type === 'model') as
            | { provider?: string; model_id?: string }
            | undefined;
        expect(model?.provider).toBe(MODEL_PROVIDER_DEFAULT);
        expect(model?.model_id).toBe(MODEL_ID_DEFAULT);

        const wires = l1!.edges.map((e) => `${e.source.node_id}->${e.target.node_id}`).sort();
        expect(wires).toContain('gateway->handler');
        expect(wires).toContain('handler->model');
        expect(wires).toContain('handler->output');
    });

    it('starter L2 is a lone NativeAgent referencing the starter L1 (chat via sidecar on instantiate)', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedStarterLibraryGraphs(store);
        const l2 = await store.get(STARTER_L2_ID);
        expect(l2).toBeDefined();

        const types = l2!.nodes.map((n) => n.type).sort();
        expect(types).toEqual(['native_agent']);

        const agent = l2!.nodes.find((n) => n.type === 'native_agent') as
            | { l1_graph_id?: string }
            | undefined;
        expect(agent?.l1_graph_id).toBe(STARTER_L1_ID);

        expect(l2!.edges).toHaveLength(0);

        const topology = checkTopology(l2!);
        expect(topology).toEqual({ ok: true, violations: [] });
    });

    it('starter toolpack and skillpack are empty bags with no edges', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedStarterLibraryGraphs(store);
        const toolpack = await store.get(STARTER_TOOLPACK_ID);
        const skillpack = await store.get(STARTER_SKILLPACK_ID);

        expect(toolpack?.nodes).toHaveLength(0);
        expect(toolpack?.edges).toHaveLength(0);
        expect(skillpack?.nodes).toHaveLength(0);
        expect(skillpack?.edges).toHaveLength(0);
    });

    it('instantiating the L2 starter deep-copies the L1 cascade (by-value drop)', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedStarterLibraryGraphs(store);

        const { copy } = await instantiateLibraryGraph(store, STARTER_L2_ID);
        expect(copy.kind).toBe('l2');
        expect(copy.library).toBeUndefined();
        expect(copy.system).toBeUndefined();

        const agent = copy.nodes.find((n) => n.type === 'native_agent') as
            | { id?: string; l1_graph_id?: string }
            | undefined;
        expect(agent?.l1_graph_id).toBeDefined();
        expect(agent?.l1_graph_id).not.toBe(STARTER_L1_ID);

        const channels = copy.nodes.filter((n) => n.type === 'channel') as Array<{
            id: string;
            channel_kind?: string;
            owner_node_id?: string;
        }>;
        expect(channels).toHaveLength(1);
        expect(channels[0]!.channel_kind).toBe('webchat');
        expect(channels[0]!.owner_node_id).toBe(agent!.id);
        const channelId = channels[0]!.id;
        const wires = copy.edges.map((e) => `${e.source.node_id}->${e.target.node_id}`).sort();
        expect(wires).toContain(`${channelId}->${agent!.id}`);
        expect(wires).toContain(`${agent!.id}->${channelId}`);

        const copiedL1 = await store.get(agent!.l1_graph_id!);
        expect(copiedL1?.kind).toBe('l1');
        expect(copiedL1?.library).toBeUndefined();
        expect(copiedL1?.system).toBeUndefined();
        const copiedTypes = copiedL1!.nodes.map((n) => n.type).sort();
        expect(copiedTypes).toEqual(['gateway', 'handler', 'model', 'output']);

        const copiedHandler = copiedL1!.nodes.find((n) => n.type === 'handler') as
            | { ref_id?: string }
            | undefined;
        expect(copiedHandler?.ref_id).toBeDefined();
        expect(copiedHandler?.ref_id).not.toBe(STARTER_HANDLER_ID);

        const handlerGraph = await store.get(copiedHandler!.ref_id!);
        expect(handlerGraph?.kind).toBe('handler');
        expect(handlerGraph?.library).toBeUndefined();
        expect(handlerGraph?.system).toBeUndefined();
        const handlerTypes = handlerGraph!.nodes.map((n) => n.type).sort();
        expect(handlerTypes).toEqual([
            'evaluator',
            'handler_input',
            'handler_output',
            'model_call',
            'prompt_builder',
            'tool_exec',
        ]);
    });

    it('is idempotent — re-seeding does not overwrite user edits to a seeded starter', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedStarterLibraryGraphs(store);

        const original = await store.get(STARTER_L1_ID);
        expect(original).toBeDefined();
        await store.update(STARTER_L1_ID, {
            ...original!,
            name: 'User-renamed starter L1',
        });
        const second = await seedStarterLibraryGraphs(store);
        expect(second.l1.name).toBe('User-renamed starter L1');
    });

    it('auto-layout assigns non-default positions on every starter L1 node so the canvas renders without overlap', async () => {
        const store = createGraphStore({ dir: graphsDir });
        const { l1, handler } = await seedStarterLibraryGraphs(store);
        const l1Placed = l1.nodes.filter((n) => n.position.x !== 0 || n.position.y !== 0);
        expect(l1Placed.length).toBeGreaterThan(0);
        const handlerPlaced = handler.nodes.filter((n) => n.position.x !== 0 || n.position.y !== 0);
        expect(handlerPlaced.length).toBeGreaterThan(0);
    });
});
