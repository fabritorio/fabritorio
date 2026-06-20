import type { Graph } from '@fabritorio/types';
import {
    STARTER_HANDLER_ID,
    STARTER_L1_ID,
    STARTER_L2_ID,
    STARTER_SKILLPACK_ID,
    STARTER_TOOLPACK_ID,
} from '@fabritorio/types';
import { autoLayout } from '../../graphs/auto-layout.js';
import {
    MODEL_PROVIDER_DEFAULT,
    MODEL_ID_DEFAULT,
    MODEL_AUTH_ENV_DEFAULT,
    MODEL_SYSTEM_PROMPT_DEFAULT,
} from '../../graphs/defaults.js';
import type { GraphStore } from '../../graphs/store.js';

function buildStarterHandlerGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'handler',
        name: 'Starter handler',
        description:
            'Library template: canonical ReAct shape (handler_input → prompt_builder → model_call → evaluator, evaluator → tool_exec → model_call loop, evaluator → handler_output on done). Drop this onto an L1 Handler `ref_id` to customise the loop; leaving `ref_id` unset runs the seeded default handler graph, which has this same shape.',
        library: true,
        system: true,
        nodes: [
            { id: 'handler-input', type: 'handler_input', position: { x: 0, y: 0 } },
            {
                id: 'prompt-builder',
                type: 'prompt_builder',
                position: { x: 0, y: 0 },
            },
            { id: 'model-call', type: 'model_call', position: { x: 0, y: 0 } },
            { id: 'evaluator', type: 'evaluator', position: { x: 0, y: 0 } },
            { id: 'tool-exec', type: 'tool_exec', position: { x: 0, y: 0 } },
            {
                id: 'handler-output',
                type: 'handler_output',
                position: { x: 0, y: 0 },
            },
        ],
        edges: [
            {
                id: 'handler-input->prompt-builder',
                source: { node_id: 'handler-input' },
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
                id: 'evaluator-done->handler-output',
                source: { node_id: 'evaluator', port_id: 'done' },
                target: { node_id: 'handler-output' },
            },
        ],
    };
    return autoLayoutDraft(draft);
}

function buildStarterL1Graph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'Starter agent',
        description:
            'Library template: Gateway → Handler → Model + Output. Drops into an L2 as a NativeAgent. The Handler refs `STARTER_HANDLER_ID` so `instantiateRecursive` deep-copies the canonical ReAct handler graph by-value on every drop — each instantiated L1 owns its own private handler graph (1:1 invariant) and double-click on the Handler node drills into it. Model provider + model_id ship as openai / gpt-4o-mini — set `OPENAI_API_KEY` to dispatch end-to-end without further config.',
        library: true,
        system: true,
        nodes: [
            { id: 'gateway', type: 'gateway', position: { x: 0, y: 0 } },
            {
                id: 'handler',
                type: 'handler',
                position: { x: 0, y: 0 },
                ref_id: STARTER_HANDLER_ID,
            },
            {
                id: 'model',
                type: 'model',
                position: { x: 0, y: 0 },
                provider: MODEL_PROVIDER_DEFAULT,
                model_id: MODEL_ID_DEFAULT,
                auth_env: MODEL_AUTH_ENV_DEFAULT,
                system_prompt: MODEL_SYSTEM_PROMPT_DEFAULT,
            },
            { id: 'output', type: 'output', position: { x: 0, y: 0 } },
        ],
        edges: [
            {
                id: 'gateway->handler',
                source: { node_id: 'gateway' },
                target: { node_id: 'handler' },
            },
            {
                id: 'handler->model',
                source: { node_id: 'handler' },
                target: { node_id: 'model' },
            },
            {
                id: 'handler->output',
                source: { node_id: 'handler' },
                target: { node_id: 'output' },
            },
        ],
    };
    return autoLayoutDraft(draft);
}

function buildStarterL2Graph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l2',
        name: 'Starter canvas',
        description:
            'Library template: a lone NativeAgent referencing the starter L1. Drops a working chat skeleton in one click — instantiate copies the L1 (and its handler) by value, so customising one drop never propagates to the template. No hand-placed Channel: per-agent chat now runs through the system-owned sidecar channel the BE mints on instantiate, so the agent alone is enough (the user-placed `channel` palette entry is hidden pre-launch, F6).',
        library: true,
        system: true,
        nodes: [
            {
                id: 'agent',
                type: 'native_agent',
                position: { x: 0, y: 0 },
                l1_graph_id: STARTER_L1_ID,
            },
        ],
        edges: [],
    };
    return autoLayoutDraft(draft);
}

function buildStarterToolPackGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'toolpack',
        name: 'Starter tool pack',
        description:
            'Library template: an empty toolpack. Drops as a `tool_pack` ref on the parent L1; fill it via the canvas by dropping individual Tool nodes from the toolpack-kind Palette.',
        library: true,
        system: true,
        nodes: [],
        edges: [],
    };
    return autoLayoutDraft(draft);
}

function buildStarterSkillPackGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'skillpack',
        name: 'Starter skill pack',
        description:
            'Library template: an empty skillpack. Drops as a `skill_pack` ref on the parent L1; fill it via the canvas by naming on-disk SKILL.md files via Skill nodes.',
        library: true,
        system: true,
        nodes: [],
        edges: [],
    };
    return autoLayoutDraft(draft);
}

function autoLayoutDraft(
    draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'>,
): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const laidOut = autoLayout(draft as Graph);
    return {
        kind: laidOut.kind,
        ...(laidOut.name !== undefined ? { name: laidOut.name } : {}),
        ...(laidOut.description !== undefined ? { description: laidOut.description } : {}),
        ...(laidOut.library !== undefined ? { library: laidOut.library } : {}),
        ...(laidOut.system !== undefined ? { system: laidOut.system } : {}),
        nodes: laidOut.nodes,
        edges: laidOut.edges,
    };
}

export async function seedStarterLibraryGraphs(store: GraphStore): Promise<{
    handler: Graph;
    toolpack: Graph;
    skillpack: Graph;
    l1: Graph;
    l2: Graph;
}> {
    const handler = await store.seed(STARTER_HANDLER_ID, buildStarterHandlerGraph());
    const toolpack = await store.seed(STARTER_TOOLPACK_ID, buildStarterToolPackGraph());
    const skillpack = await store.seed(STARTER_SKILLPACK_ID, buildStarterSkillPackGraph());
    const l1 = await store.seed(STARTER_L1_ID, buildStarterL1Graph());
    const l2 = await store.seed(STARTER_L2_ID, buildStarterL2Graph());
    return { handler, toolpack, skillpack, l1, l2 };
}
