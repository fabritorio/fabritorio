import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphStore } from '../../../src/graphs/store.js';
import {
    TOOL_BUILDER_L1_ID,
    SKILL_BUILDER_L1_ID,
    CODER_L1_ID,
    CODER_TOOL_NAMES,
    CODER_TOOLS_ID,
    FOREMAN_L1_ID,
    FOREMAN_TOOL_NAMES,
    FOREMAN_TOOLS_ID,
    seedToolBuilderL1,
    seedSkillBuilderL1,
    seedCoderL1,
    seedCoderTools,
    seedForemanLibraryGraphs,
} from '../../../src/runtime/handlers/foreman-seeds.js';
import { DEFAULT_SIMPLE_HANDLER_ID } from '../../../src/runtime/handlers/default-graph.js';

describe('seedForemanLibraryGraphs', () => {
    let graphsDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-foreman-seeds-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
    });

    it('seeds the Foreman pair at their stable ids with the expected kinds and library flag', async () => {
        const store = createGraphStore({ dir: graphsDir });
        const result = await seedForemanLibraryGraphs(store);

        expect(result.tools.id).toBe(FOREMAN_TOOLS_ID);
        expect(result.l1.id).toBe(FOREMAN_L1_ID);

        expect(result.tools.kind).toBe('toolpack');
        expect(result.l1.kind).toBe('l1');

        for (const g of [result.tools, result.l1]) {
            expect(g.library).toBe(true);
        }

        const tools = await store.get(FOREMAN_TOOLS_ID);
        const l1 = await store.get(FOREMAN_L1_ID);
        expect(tools?.kind).toBe('toolpack');
        expect(l1?.kind).toBe('l1');
    });

    it('foreman-tools contains a tool node for each cross-graph + session tool', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const tools = await store.get(FOREMAN_TOOLS_ID);
        expect(tools).toBeDefined();
        const toolNames = tools!.nodes
            .filter((n) => n.type === 'tool')
            // tool_name is on ToolNode but the union here is Node, so cast.
            .map((n) => (n as { tool_name: string }).tool_name)
            .sort();
        expect(toolNames).toEqual([...FOREMAN_TOOL_NAMES].sort());
    });

    it('foreman-l1 wires gateway → handler → output, plus model + tool_pack(ref) + skill(name)', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const l1 = await store.get(FOREMAN_L1_ID);
        expect(l1).toBeDefined();

        const types = l1!.nodes.map((n) => n.type).sort();
        expect(types).toEqual(['gateway', 'handler', 'model', 'output', 'skill', 'tool_pack']);

        const handler = l1!.nodes.find((n) => n.type === 'handler') as
            | { ref_id?: string }
            | undefined;
        expect(handler?.ref_id).toBe(DEFAULT_SIMPLE_HANDLER_ID);

        const toolPack = l1!.nodes.find((n) => n.type === 'tool_pack') as
            | { ref_id?: string }
            | undefined;
        expect(toolPack?.ref_id).toBe(FOREMAN_TOOLS_ID);

        const skill = l1!.nodes.find((n) => n.type === 'skill') as { name?: string } | undefined;
        expect(skill?.name).toBe('foreman');

        const wires = l1!.edges.map((e) => `${e.source.node_id}->${e.target.node_id}`).sort();
        expect(wires).toContain('gateway->handler');
        expect(wires).toContain('handler->output');
        expect(wires).toContain('handler->model');
        expect(wires).toContain('tools->handler');
        expect(wires).toContain('skill-foreman->handler');
    });

    it('foreman-l1 ships a model-facing description (becomes the dropped node ask_agent desc)', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const l1 = await store.get(FOREMAN_L1_ID);
        expect(l1?.description).toMatch(/orchestrat/i);
    });

    it('is idempotent — re-seeding does not overwrite user edits to the seeded ids', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);

        const original = await store.get(FOREMAN_TOOLS_ID);
        expect(original).toBeDefined();
        const updated = await store.update(FOREMAN_TOOLS_ID, {
            ...original!,
            name: 'User-renamed tools',
        });
        expect(updated?.name).toBe('User-renamed tools');

        const secondPass = await seedForemanLibraryGraphs(store);
        expect(secondPass.tools.name).toBe('User-renamed tools');
    });

    it('seeds carry system:true so they are delete/rename/edit protected', async () => {
        const store = createGraphStore({ dir: graphsDir });
        const result = await seedForemanLibraryGraphs(store);
        for (const g of Object.values(result)) {
            expect(g.system).toBe(true);
        }
    });

    it('heals a legacy seed that predates the system flag on the next boot', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await store.seed(FOREMAN_TOOLS_ID, {
            kind: 'toolpack',
            name: 'legacy tools',
            library: true,
            nodes: [],
            edges: [],
        });
        const before = await store.get(FOREMAN_TOOLS_ID);
        expect(before?.system).not.toBe(true);

        await seedForemanLibraryGraphs(store);

        const after = await store.get(FOREMAN_TOOLS_ID);
        expect(after?.system).toBe(true);
        expect(after?.name).toBe('legacy tools');
    });

    it('auto-layout assigns non-default positions on every L1 node so the canvas renders without overlap', async () => {
        const store = createGraphStore({ dir: graphsDir });
        const { l1 } = await seedForemanLibraryGraphs(store);
        const placed = l1.nodes.filter((n) => n.position.x !== 0 || n.position.y !== 0);
        expect(placed.length).toBeGreaterThan(0);
    });

    it('seeds the sub-agent library set at their stable ids with the expected kinds', async () => {
        const store = createGraphStore({ dir: graphsDir });
        const result = await seedForemanLibraryGraphs(store);

        expect(result.coderTools.id).toBe(CODER_TOOLS_ID);
        expect(result.coderL1.id).toBe(CODER_L1_ID);
        expect(result.toolBuilderL1.id).toBe(TOOL_BUILDER_L1_ID);
        expect(result.skillBuilderL1.id).toBe(SKILL_BUILDER_L1_ID);

        expect(result.coderTools.kind).toBe('toolpack');
        expect(result.coderL1.kind).toBe('l1');
        expect(result.toolBuilderL1.kind).toBe('l1');
        expect(result.skillBuilderL1.kind).toBe('l1');

        for (const g of [
            result.coderTools,
            result.coderL1,
            result.toolBuilderL1,
            result.skillBuilderL1,
        ]) {
            expect(g.library).toBe(true);
        }

        const coderTools = await store.get(CODER_TOOLS_ID);
        const coderL1 = await store.get(CODER_L1_ID);
        const toolBuilderL1 = await store.get(TOOL_BUILDER_L1_ID);
        const skillBuilderL1 = await store.get(SKILL_BUILDER_L1_ID);
        expect(coderTools?.kind).toBe('toolpack');
        expect(coderL1?.kind).toBe('l1');
        expect(toolBuilderL1?.kind).toBe('l1');
        expect(skillBuilderL1?.kind).toBe('l1');
    });

    it('coder-tools contains exactly the 5 fs+bash tools (no ask_agent / prior_turns)', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const tools = await store.get(CODER_TOOLS_ID);
        expect(tools).toBeDefined();
        const toolNames = tools!.nodes
            .filter((n) => n.type === 'tool')
            .map((n) => (n as { tool_name: string }).tool_name)
            .sort();
        expect(toolNames).toEqual([...CODER_TOOL_NAMES].sort());
        expect(toolNames).not.toContain('ask_agent');
        expect(toolNames).not.toContain('prior_turns');
    });

    it('coder-l1 wires gateway → handler → output, plus model + tool_pack(ref) + workspace, no skill', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const l1 = await store.get(CODER_L1_ID);
        expect(l1).toBeDefined();

        const types = l1!.nodes.map((n) => n.type).sort();
        expect(types).toEqual(['gateway', 'handler', 'model', 'output', 'tool_pack', 'workspace']);

        const handler = l1!.nodes.find((n) => n.type === 'handler') as
            | { ref_id?: string }
            | undefined;
        expect(handler?.ref_id).toBe(DEFAULT_SIMPLE_HANDLER_ID);

        const toolPack = l1!.nodes.find((n) => n.type === 'tool_pack') as
            | { ref_id?: string }
            | undefined;
        expect(toolPack?.ref_id).toBe(CODER_TOOLS_ID);

        const workspace = l1!.nodes.find((n) => n.type === 'workspace') as
            | { path?: string; permissions?: string }
            | undefined;
        expect(workspace?.permissions).toBe('read-write');
        expect(typeof workspace?.path).toBe('string');
        expect(workspace?.path?.length ?? 0).toBeGreaterThan(0);

        const wires = l1!.edges.map((e) => `${e.source.node_id}->${e.target.node_id}`).sort();
        expect(wires).toContain('gateway->handler');
        expect(wires).toContain('handler->output');
        expect(wires).toContain('handler->model');
        expect(wires).toContain('tools->handler');
        expect(wires).toContain('workspace->handler');
        expect(l1!.nodes.some((n) => n.type === 'skill')).toBe(false);
    });

    it('tool-builder-l1 mirrors the Coder shape plus the tool-builder skill, sharing the fs+bash toolpack', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const l1 = await store.get(TOOL_BUILDER_L1_ID);
        expect(l1).toBeDefined();

        const types = l1!.nodes.map((n) => n.type).sort();
        expect(types).toEqual([
            'gateway',
            'handler',
            'model',
            'output',
            'skill',
            'tool_pack',
            'workspace',
        ]);

        const toolPack = l1!.nodes.find((n) => n.type === 'tool_pack') as
            | { ref_id?: string }
            | undefined;
        expect(toolPack?.ref_id).toBe(CODER_TOOLS_ID);

        const skill = l1!.nodes.find((n) => n.type === 'skill') as { name?: string } | undefined;
        expect(skill?.name).toBe('tool-builder');

        const wires = l1!.edges.map((e) => `${e.source.node_id}->${e.target.node_id}`).sort();
        expect(wires).toContain('tools->handler');
        expect(wires).toContain('workspace->handler');
        expect(wires).toContain('skill-tool-builder->handler');
    });

    it('tool-builder-l1 ships the model-facing description that seeds the dropped node ask_agent desc', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const l1 = await store.get(TOOL_BUILDER_L1_ID);
        expect(l1?.description).toMatch(/runtime tool/i);
    });

    it('skill-builder-l1 mirrors the Tool builder shape plus the skill-builder skill, sharing the fs+bash toolpack', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const l1 = await store.get(SKILL_BUILDER_L1_ID);
        expect(l1).toBeDefined();

        const types = l1!.nodes.map((n) => n.type).sort();
        expect(types).toEqual([
            'gateway',
            'handler',
            'model',
            'output',
            'skill',
            'tool_pack',
            'workspace',
        ]);

        const toolPack = l1!.nodes.find((n) => n.type === 'tool_pack') as
            | { ref_id?: string }
            | undefined;
        expect(toolPack?.ref_id).toBe(CODER_TOOLS_ID);

        const workspace = l1!.nodes.find((n) => n.type === 'workspace') as
            | { path?: string; permissions?: string }
            | undefined;
        expect(workspace?.permissions).toBe('read-write');
        expect(typeof workspace?.path).toBe('string');

        const skill = l1!.nodes.find((n) => n.type === 'skill') as { name?: string } | undefined;
        expect(skill?.name).toBe('skill-builder');

        const wires = l1!.edges.map((e) => `${e.source.node_id}->${e.target.node_id}`).sort();
        expect(wires).toContain('tools->handler');
        expect(wires).toContain('workspace->handler');
        expect(wires).toContain('skill-skill-builder->handler');
    });

    it('skill-builder-l1 ships the model-facing description that seeds the dropped node ask_agent desc', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);
        const l1 = await store.get(SKILL_BUILDER_L1_ID);
        expect(l1?.description).toMatch(/skill/i);
    });

    it('re-seeding the sub-agent set is idempotent', async () => {
        const store = createGraphStore({ dir: graphsDir });
        await seedForemanLibraryGraphs(store);

        const original = await store.get(TOOL_BUILDER_L1_ID);
        expect(original).toBeDefined();
        await store.update(TOOL_BUILDER_L1_ID, {
            ...original!,
            description: 'User-edited tool builder',
        });

        const second = await seedForemanLibraryGraphs(store);
        expect(second.toolBuilderL1.description).toBe('User-edited tool builder');

        const coderToolsAgain = await seedCoderTools(store);
        const coderL1Again = await seedCoderL1(store);
        const toolBuilderL1Again = await seedToolBuilderL1(store);
        const skillBuilderL1Again = await seedSkillBuilderL1(store);
        expect(coderToolsAgain.id).toBe(CODER_TOOLS_ID);
        expect(coderL1Again.id).toBe(CODER_L1_ID);
        expect(toolBuilderL1Again.id).toBe(TOOL_BUILDER_L1_ID);
        expect(toolBuilderL1Again.description).toBe('User-edited tool builder');
        expect(skillBuilderL1Again.id).toBe(SKILL_BUILDER_L1_ID);
    });
});
