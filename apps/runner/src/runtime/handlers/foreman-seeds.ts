import type { Graph } from '@fabritorio/types';
import { autoLayout } from '../../graphs/auto-layout.js';
import type { GraphStore } from '../../graphs/store.js';
import { DEFAULT_SIMPLE_HANDLER_ID } from './default-graph.js';

export const FOREMAN_TOOLS_ID = '00000000-0000-4000-8000-0000000f0001';
export const FOREMAN_L1_ID = '00000000-0000-4000-8000-0000000f0002';

export const CODER_L1_ID = '00000000-0000-4000-8000-0000000c0001';
export const CODER_TOOLS_ID = '00000000-0000-4000-8000-0000000c0002';
export const TOOL_BUILDER_L1_ID = '00000000-0000-4000-8000-0000000c0004';
export const SKILL_BUILDER_L1_ID = '00000000-0000-4000-8000-0000000c0005';

export const CODER_TOOL_NAMES = [
    'read_file',
    'write_file',
    'edit_file',
    'list_directory',
    'bash',
] as const;

export const FOREMAN_TOOL_NAMES = [
    'read_canvas',
    'read_graph',
    'create_graph',
    'edit_graph',
    'instantiate_composite',
    'ask_agent',
    'prior_turns',
] as const;

function buildForemanToolsGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const nodes = FOREMAN_TOOL_NAMES.map((tool_name) => ({
        id: `tool-${tool_name}`,
        type: 'tool' as const,
        position: { x: 0, y: 0 },
        tool_name,
    }));
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'toolpack',
        name: 'Foreman cross-graph tools',
        description:
            "Library tool pack: the cross-graph built-in tools Foreman uses to introspect and rewrite the active canvas, plus the session helpers it needs to act inside a live conversation. Canvas authoring: `read_canvas` returns the user's L2 (channels / agents / triggers); `read_graph` drills into a specific subgraph by id; `create_graph` / `edit_graph` write graphs; `instantiate_composite` stamps a library template into a live copy. Session: `ask_agent` synchronously delegates to a wired sub-agent; `prior_turns` returns the recent root-Dispatch turns of the current session so Foreman can recover earlier conversation context.",
        library: true,
        system: true,
        nodes,
        edges: [],
    };
    return autoLayoutDraft(draft);
}

function buildForemanL1Graph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'Foreman agent',
        description:
            'Orchestrator agent that reads and rewrites the live canvas, designs and wires other agents, and delegates to wired sub-agents. Ships the cross-graph authoring tools (read_canvas / read_graph / create_graph / edit_graph / instantiate_composite), the session helpers (ask_agent, prior_turns), and the `foreman` playbook skill. Drop it as a NativeAgent and wire a Channel to chat with it; wire other agents downstream for it to call.',
        library: true,
        system: true,
        nodes: [
            { id: 'gateway', type: 'gateway', position: { x: 0, y: 0 } },
            {
                id: 'handler',
                type: 'handler',
                position: { x: 0, y: 0 },
                ref_id: DEFAULT_SIMPLE_HANDLER_ID,
                max_iterations: 12,
            },
            {
                id: 'model',
                type: 'model',
                position: { x: 0, y: 0 },
                provider: 'anthropic',
                model_id: 'claude-sonnet-4-5',
                auth_env: 'ANTHROPIC_API_KEY',
                temperature: 0.2,
                system_prompt:
                    'You are Foreman, an agent that builds and dispatches other agents on the Fabritorio canvas.\n\n**REQUIRED first tool call on any agent-design request — building, sparring, wiring, designing, "how should I", "what would you suggest", or planning conversations: call `Skill({name: "foreman"})` to load your playbook BEFORE replying.** No exceptions for "this seems simple" or "let me just brainstorm." Your default architectural instincts about agent design (suggesting custom tools, proposing API integrations, treating toolpacks as the customization axis) are WRONG for Fabritorio — the playbook overrides them. Skipping the load means you will give wrong advice; you have done so before.\n\nOnly skip the skill load for trivial introspection ("what time is it", "what\'s on the canvas") that doesn\'t involve design.\n\nAfter loading the skill: `read_canvas` first to see the user\'s current L2, then `read_graph` / `create_graph` / `edit_graph` / `instantiate_composite` to inspect or write graphs, `ask_agent` to delegate synchronously to a wired sub-agent, and `prior_turns` to recover earlier conversation context when continuing a multi-turn session. The L2 you live inside is the only orchestration you should write into; don\'t list other graphs ambiently.\n\nNever invent a `tool_name` — it must resolve against the built-in catalog OR the runtime tool registry. The built-in catalog is closed, but the registry is extensible: for a capability neither covers, delegate to the **Tool builder** sub-agent (distinct from the generic Coder) to build a runtime tool (binary + manifest.json), then wire a `tool` node — see the playbook\'s section 4. A `bash` + CLI + skill workaround is a fallback for one-off work only.',
            },
            { id: 'output', type: 'output', position: { x: 0, y: 0 } },
            {
                id: 'tools',
                type: 'tool_pack',
                position: { x: 0, y: 0 },
                pack_name: 'Foreman tools',
                ref_id: FOREMAN_TOOLS_ID,
            },
            {
                id: 'skill-foreman',
                type: 'skill',
                position: { x: 0, y: 0 },
                name: 'foreman',
            },
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
            {
                id: 'tools->handler',
                source: { node_id: 'tools' },
                target: { node_id: 'handler' },
            },
            {
                id: 'skill-foreman->handler',
                source: { node_id: 'skill-foreman' },
                target: { node_id: 'handler' },
            },
        ],
    };
    return autoLayoutDraft(draft);
}

function buildCoderToolsGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const nodes = CODER_TOOL_NAMES.map((tool_name) => ({
        id: `tool-${tool_name}`,
        type: 'tool' as const,
        position: { x: 0, y: 0 },
        tool_name,
    }));
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'toolpack',
        name: 'Filesystem + bash tools',
        description:
            'Library tool pack: read_file / write_file / edit_file / list_directory / bash. Wired into a sub-agent L1 alongside a Workspace node so the model can inspect and rewrite files inside a bounded directory. Shared by the generic Coder and the Tool builder — same tool set, different skill + workspace. Mirrors the Foreman tools pack but for filesystem work rather than canvas authoring.',
        library: true,
        system: true,
        nodes,
        edges: [],
    };
    return autoLayoutDraft(draft);
}

function buildCoderL1Graph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'Coder agent',
        description:
            'General-purpose filesystem + bash worker for ad-hoc file tasks: reads, writes, and edits files and runs shell commands inside a bounded Workspace. Ships the fs+bash tools (read_file / write_file / edit_file / list_directory / bash) and no specialist skill. Delegate here for one-off code or file work that no dedicated tool covers; it returns its result as a single reply. Drop it as a NativeAgent alongside an orchestrator and wire the orchestrator → coder edge.',
        library: true,
        system: true,
        nodes: [
            { id: 'gateway', type: 'gateway', position: { x: 0, y: 0 } },
            {
                id: 'handler',
                type: 'handler',
                position: { x: 0, y: 0 },
                ref_id: DEFAULT_SIMPLE_HANDLER_ID,
                max_iterations: 12,
            },
            {
                id: 'model',
                type: 'model',
                position: { x: 0, y: 0 },
                provider: 'anthropic',
                model_id: 'claude-sonnet-4-5',
                auth_env: 'ANTHROPIC_API_KEY',
                temperature: 0.2,
                system_prompt:
                    'You are a coder agent. You receive briefs from an orchestrator. Implement what is asked, then report back what you did. You have file ops (read_file / write_file / edit_file / list_directory) and bash, scoped to a single Workspace directory. Keep replies concise and factual: what you changed, what you ran, what you observed. Do not ask the user follow-up questions — your caller is another agent, not a human, and it expects a single tool-result-shaped reply.',
            },
            { id: 'output', type: 'output', position: { x: 0, y: 0 } },
            {
                id: 'tools',
                type: 'tool_pack',
                position: { x: 0, y: 0 },
                pack_name: 'Coder tools',
                ref_id: CODER_TOOLS_ID,
            },
            {
                id: 'workspace',
                type: 'workspace',
                position: { x: 0, y: 0 },
                path: '~/fabritorio-coder',
                permissions: 'read-write',
            },
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
            {
                id: 'tools->handler',
                source: { node_id: 'tools' },
                target: { node_id: 'handler' },
            },
            {
                id: 'workspace->handler',
                source: { node_id: 'workspace' },
                target: { node_id: 'handler' },
            },
        ],
    };
    return autoLayoutDraft(draft);
}

function buildToolBuilderL1Graph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'Tool builder agent',
        description:
            'Builds a runtime tool on demand from an integration brief. Give it an external API or CLI you want to call (e.g. "wrap the Linear API as a tool") and it produces a runnable binary + manifest.json under ~/.fabritorio/ that you can wire as a `tool` node. Has filesystem + bash access and the tool-builder skill. Delegate here whenever no built-in tool or skill covers a capability; it returns the built tool name and manifest so you can wire it.',
        library: true,
        system: true,
        nodes: [
            { id: 'gateway', type: 'gateway', position: { x: 0, y: 0 } },
            {
                id: 'handler',
                type: 'handler',
                position: { x: 0, y: 0 },
                ref_id: DEFAULT_SIMPLE_HANDLER_ID,
                max_iterations: 12,
            },
            {
                id: 'model',
                type: 'model',
                position: { x: 0, y: 0 },
                provider: 'anthropic',
                model_id: 'claude-sonnet-4-5',
                auth_env: 'ANTHROPIC_API_KEY',
                temperature: 0.2,
                system_prompt:
                    'You are the Tool builder — a coder sub-agent that wraps external integrations as runtime tools. You receive briefs from an orchestrator (usually Foreman) or chat directly with a user, shaped like "build a CLI for X".\n\n**REQUIRED first tool call on any build/extend request: `Skill({name: "tool-builder"})` to load your playbook BEFORE writing code or running bash.** The playbook is the source of truth for the deliverable, path discipline, manifest shape, build sequence, what to clarify, and what to report — don\'t reconstruct them from memory. The one thing you must get right in the window before it loads: your default instinct to ship a SKILL.md that teaches bash invocation is WRONG — the product is a manifest.json that registers the binary as a first-class tool. Acting on that instinct before you load the playbook means wrong artifacts.\n\nYou have file ops (read_file / write_file / edit_file / list_directory) and bash, scoped to the `~/.fabritorio/` Workspace.\n\nClarify when the spec is underspecified; build when it is sufficient — the skill\'s "What to clarify" section says exactly what to extract, and its "What to report back" section the reply shape. Reply goes to whoever sent the request.',
            },
            { id: 'output', type: 'output', position: { x: 0, y: 0 } },
            {
                id: 'tools',
                type: 'tool_pack',
                position: { x: 0, y: 0 },
                pack_name: 'Filesystem + bash tools',
                ref_id: CODER_TOOLS_ID,
            },
            {
                id: 'workspace',
                type: 'workspace',
                position: { x: 0, y: 0 },
                path: '~/.fabritorio',
                permissions: 'read-write',
            },
            {
                id: 'skill-tool-builder',
                type: 'skill',
                position: { x: 0, y: 0 },
                name: 'tool-builder',
            },
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
            {
                id: 'tools->handler',
                source: { node_id: 'tools' },
                target: { node_id: 'handler' },
            },
            {
                id: 'workspace->handler',
                source: { node_id: 'workspace' },
                target: { node_id: 'handler' },
            },
            {
                id: 'skill-tool-builder->handler',
                source: { node_id: 'skill-tool-builder' },
                target: { node_id: 'handler' },
            },
        ],
    };
    return autoLayoutDraft(draft);
}

function buildSkillBuilderL1Graph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    const draft: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l1',
        name: 'Skill builder agent',
        description:
            'Authors a progressive-disclosure skill on demand from a brief. Give it a capability you want an agent to have the judgment for (e.g. "write a skill for triaging Sentry issues" or "teach an agent our git release workflow") and it produces a SKILL.md (+ optional resource files) under ~/.fabritorio/skills/<name>/ that you can wire as a `skill` node. Has filesystem + bash access and the skill-builder skill. Delegate here to add when/why/workflow knowledge — NOT to make a binary callable as a gated tool (that\'s the Tool builder). It returns the built skill name so you can wire it.',
        library: true,
        system: true,
        nodes: [
            { id: 'gateway', type: 'gateway', position: { x: 0, y: 0 } },
            {
                id: 'handler',
                type: 'handler',
                position: { x: 0, y: 0 },
                ref_id: DEFAULT_SIMPLE_HANDLER_ID,
                max_iterations: 12,
            },
            {
                id: 'model',
                type: 'model',
                position: { x: 0, y: 0 },
                provider: 'anthropic',
                model_id: 'claude-sonnet-4-5',
                auth_env: 'ANTHROPIC_API_KEY',
                temperature: 0.2,
                system_prompt:
                    'You are the Skill builder — a coder sub-agent that authors progressive-disclosure skills (SKILL.md playbooks) that teach an agent the judgment for a capability. You receive briefs from an orchestrator (usually Foreman) or chat directly with a user, shaped like "write a skill for X".\n\n**REQUIRED first tool call on any build/extend request: `Skill({name: "skill-builder"})` to load your playbook BEFORE writing files or running bash.** The playbook is the source of truth for the deliverable, path discipline, the ontology boundary, what to clarify, the verify-by-probe step, and what to report — don\'t reconstruct them from memory. The one thing you must get right in the window before it loads: your default instinct to write a SKILL.md that just teaches "call this binary via bash like so" is WRONG — that\'s a capability shim, and the right move is to hand off to the Tool builder. A skill teaches when/why/which-flag/workflow; it never wraps a call. Acting on that instinct before you load the playbook means wrong artifacts.\n\nYou have file ops (read_file / write_file / edit_file / list_directory) and bash, scoped to the `~/.fabritorio/` Workspace.\n\nClarify when the spec is underspecified; build when it is sufficient — the skill\'s "What to clarify" section says exactly what to extract, and its "What to report back" section the reply shape. Probe the finished skill before reporting success. Reply goes to whoever sent the request.',
            },
            { id: 'output', type: 'output', position: { x: 0, y: 0 } },
            {
                id: 'tools',
                type: 'tool_pack',
                position: { x: 0, y: 0 },
                pack_name: 'Filesystem + bash tools',
                ref_id: CODER_TOOLS_ID,
            },
            {
                id: 'workspace',
                type: 'workspace',
                position: { x: 0, y: 0 },
                path: '~/.fabritorio',
                permissions: 'read-write',
            },
            {
                id: 'skill-skill-builder',
                type: 'skill',
                position: { x: 0, y: 0 },
                name: 'skill-builder',
            },
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
            {
                id: 'tools->handler',
                source: { node_id: 'tools' },
                target: { node_id: 'handler' },
            },
            {
                id: 'workspace->handler',
                source: { node_id: 'workspace' },
                target: { node_id: 'handler' },
            },
            {
                id: 'skill-skill-builder->handler',
                source: { node_id: 'skill-skill-builder' },
                target: { node_id: 'handler' },
            },
        ],
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
        nodes: laidOut.nodes,
        edges: laidOut.edges,
    };
}

export async function seedForemanLibraryGraphs(store: GraphStore): Promise<{
    tools: Graph;
    l1: Graph;
    coderTools: Graph;
    coderL1: Graph;
    toolBuilderL1: Graph;
    skillBuilderL1: Graph;
}> {
    const tools = await healSystemFlag(
        store,
        await store.seed(FOREMAN_TOOLS_ID, buildForemanToolsGraph()),
    );
    const l1 = await healSystemFlag(store, await store.seed(FOREMAN_L1_ID, buildForemanL1Graph()));
    const coderTools = await healSystemFlag(
        store,
        await store.seed(CODER_TOOLS_ID, buildCoderToolsGraph()),
    );
    const coderL1 = await healSystemFlag(store, await store.seed(CODER_L1_ID, buildCoderL1Graph()));
    const toolBuilderL1 = await healSystemFlag(
        store,
        await store.seed(TOOL_BUILDER_L1_ID, buildToolBuilderL1Graph()),
    );
    const skillBuilderL1 = await healSystemFlag(
        store,
        await store.seed(SKILL_BUILDER_L1_ID, buildSkillBuilderL1Graph()),
    );
    return { tools, l1, coderTools, coderL1, toolBuilderL1, skillBuilderL1 };
}

async function healSystemFlag(store: GraphStore, graph: Graph): Promise<Graph> {
    if (graph.system === true) return graph;
    const { id, created_at: _created, updated_at: _updated, ...rest } = graph;
    if (!id) return graph;
    const healed = await store.update(id, { ...rest, system: true });
    return healed ?? graph;
}

export async function seedCoderTools(store: GraphStore): Promise<Graph> {
    return store.seed(CODER_TOOLS_ID, buildCoderToolsGraph());
}

export async function seedCoderL1(store: GraphStore): Promise<Graph> {
    return store.seed(CODER_L1_ID, buildCoderL1Graph());
}

export async function seedToolBuilderL1(store: GraphStore): Promise<Graph> {
    return store.seed(TOOL_BUILDER_L1_ID, buildToolBuilderL1Graph());
}

export async function seedSkillBuilderL1(store: GraphStore): Promise<Graph> {
    return store.seed(SKILL_BUILDER_L1_ID, buildSkillBuilderL1Graph());
}
