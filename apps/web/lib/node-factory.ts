import type {
    ChannelNode,
    CliAgentNode,
    CheckpointNode,
    CliInvocationTargetNode,
    DebugGatewayNode,
    DebugProbeNode,
    EvaluatorNode,
    GatewayNode,
    GraphKind,
    HandlerInputNode,
    HandlerNode,
    HandlerOutputNode,
    MemoryNode,
    ModelCallNode,
    ModelNode,
    ModelRouterNode,
    NativeAgentNode,
    Node,
    OutputNode,
    PermissionNode,
    PiAgentNode,
    Position,
    PromptBuilderNode,
    SecretsNode,
    SkillNode,
    SkillPackNode,
    ToolExecNode,
    ToolNode,
    ToolPackNode,
    TriggerNode,
    WorkspaceNode,
} from '@fabritorio/types';

export type SavedRefKind = 'toolpack' | 'skillpack' | 'handler' | 'l1';

export type ToolPackPaletteKind = 'tool' | 'tool_pack';
export type SkillPackPaletteKind = 'skill' | 'skill_pack';
export type HandlerPaletteKind =
    | 'handler_input'
    | 'handler_output'
    | 'prompt_builder'
    | 'model_call'
    | 'tool_exec'
    | 'evaluator'
    | 'debug_probe';
export type CliInvocationPaletteKind =
    | 'cli_invocation_target'
    | 'model'
    | 'workspace'
    | 'skill'
    | 'skill_pack';

export type L1PaletteKind =
    | 'gateway'
    | 'output'
    | 'handler'
    | 'model'
    | 'model_router'
    | 'tool'
    | 'tool_pack'
    | 'skill'
    | 'skill_pack'
    | 'workspace'
    | 'secrets'
    | 'permission'
    | 'checkpoint'
    | 'debug_gateway'
    | 'debug_probe';

export type L2PaletteKind =
    | 'channel'
    | 'trigger'
    | 'schedule'
    | 'manual'
    | 'native_agent'
    | 'cli_agent'
    | 'pi_agent'
    | 'memory'
    | 'debug_gateway'
    | 'debug_probe';

export type PaletteKind =
    | ToolPackPaletteKind
    | SkillPackPaletteKind
    | HandlerPaletteKind
    | CliInvocationPaletteKind
    | L1PaletteKind
    | L2PaletteKind;

const PREFIX: Record<PaletteKind, string> = {
    gateway: 'gateway',
    output: 'output',
    handler: 'handler',
    model: 'model',
    model_router: 'model-router',
    tool: 'tool',
    tool_pack: 'pack',
    skill: 'skill',
    skill_pack: 'skill-pack',
    workspace: 'workspace',
    secrets: 'secrets',
    channel: 'channel',
    trigger: 'trigger',
    schedule: 'schedule',
    manual: 'manual',
    native_agent: 'agent',
    cli_agent: 'cli',
    pi_agent: 'pi',
    memory: 'memory',
    handler_input: 'h-in',
    handler_output: 'h-out',
    prompt_builder: 'prompt',
    model_call: 'model-call',
    tool_exec: 'tool-exec',
    evaluator: 'eval',
    cli_invocation_target: 'cli-target',
    debug_gateway: 'debug',
    debug_probe: 'probe',
    permission: 'perm',
    checkpoint: 'checkpoint',
};

export const TOOLPACK_PALETTE_KINDS: ReadonlySet<ToolPackPaletteKind> =
    new Set<ToolPackPaletteKind>(['tool', 'tool_pack']);

export const SKILLPACK_PALETTE_KINDS: ReadonlySet<SkillPackPaletteKind> =
    new Set<SkillPackPaletteKind>(['skill', 'skill_pack']);

export const HANDLER_PALETTE_KINDS: ReadonlySet<HandlerPaletteKind> = new Set<HandlerPaletteKind>([
    'handler_input',
    'handler_output',
    'prompt_builder',
    'model_call',
    'tool_exec',
    'evaluator',
    'debug_probe',
]);

export const CLI_INVOCATION_PALETTE_KINDS: ReadonlySet<CliInvocationPaletteKind> =
    new Set<CliInvocationPaletteKind>([
        'cli_invocation_target',
        'model',
        'workspace',
        'skill',
        'skill_pack',
    ]);

export const L1_PALETTE_KINDS: ReadonlySet<L1PaletteKind> = new Set<L1PaletteKind>([
    'gateway',
    'output',
    'handler',
    'model',
    'model_router',
    'tool',
    'tool_pack',
    'skill',
    'skill_pack',
    'workspace',
    'secrets',
    'permission',
    'checkpoint',
    'debug_gateway',
    'debug_probe',
]);

export const L2_PALETTE_KINDS: ReadonlySet<L2PaletteKind> = new Set<L2PaletteKind>([
    'channel',
    'trigger',
    'schedule',
    'manual',
    'native_agent',
    'cli_agent',
    'pi_agent',
    'memory',
    'debug_gateway',
    'debug_probe',
]);

export function paletteKindsForGraphKind(kind: GraphKind): ReadonlySet<PaletteKind> {
    switch (kind) {
        case 'toolpack':
            return TOOLPACK_PALETTE_KINDS;
        case 'skillpack':
            return SKILLPACK_PALETTE_KINDS;
        case 'handler':
            return HANDLER_PALETTE_KINDS;
        case 'cli_invocation':
            return CLI_INVOCATION_PALETTE_KINDS;
        case 'l1':
            return L1_PALETTE_KINDS;
        case 'l2':
            return L2_PALETTE_KINDS;
    }
}

function shortToken(): string {
    const c = globalThis.crypto;
    if (c?.getRandomValues) {
        const bytes = new Uint8Array(4);
        c.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (typeof c?.randomUUID === 'function') return c.randomUUID().slice(0, 8);
    return Math.floor(Math.random() * 0xffffffff)
        .toString(16)
        .padStart(8, '0');
}

export function nextNodeId(type: Node['type'] | PaletteKind): string {
    const prefix = (PREFIX as Record<string, string>)[type] ?? type;
    return `${prefix}-${shortToken()}`;
}

export function buildNode(kind: PaletteKind, position: Position): Node {
    const id = nextNodeId(kind);
    switch (kind) {
        case 'gateway': {
            const node: GatewayNode = { id, type: 'gateway', position };
            return node;
        }
        case 'output': {
            const node: OutputNode = { id, type: 'output', position };
            return node;
        }
        case 'handler': {
            const node: HandlerNode = { id, type: 'handler', position };
            return node;
        }
        case 'model': {
            const node: ModelNode = {
                id,
                type: 'model',
                position,
                provider: '',
                model_id: '',
            };
            return node;
        }
        case 'model_router': {
            const node: ModelRouterNode = {
                id,
                type: 'model_router',
                position,
                policy: 'failover',
            };
            return node;
        }
        case 'tool': {
            const node: ToolNode = { id, type: 'tool', position, tool_name: '' };
            return node;
        }
        case 'tool_pack': {
            const node: ToolPackNode = { id, type: 'tool_pack', position };
            return node;
        }
        case 'skill': {
            const node: SkillNode = { id, type: 'skill', position, name: '' };
            return node;
        }
        case 'skill_pack': {
            const node: SkillPackNode = { id, type: 'skill_pack', position };
            return node;
        }
        case 'workspace': {
            const node: WorkspaceNode = {
                id,
                type: 'workspace',
                position,
                path: '',
                permissions: 'read-write',
            };
            return node;
        }
        case 'secrets': {
            const node: SecretsNode = {
                id,
                type: 'secrets',
                position,
                bindings: [],
            };
            return node;
        }
        case 'channel': {
            const node: ChannelNode = {
                id,
                type: 'channel',
                position,
                channel_kind: 'webchat',
            };
            return node;
        }
        case 'trigger': {
            const node: TriggerNode = {
                id,
                type: 'trigger',
                position,
                trigger_kind: 'cron',
                expression: '*/5 * * * *',
            };
            return node;
        }
        case 'schedule': {
            const node: TriggerNode = {
                id,
                type: 'trigger',
                position,
                trigger_kind: 'schedule',
                recurrence: { kind: 'interval', every: 'PT15M' },
            };
            return node;
        }
        case 'manual': {
            const node: TriggerNode = {
                id,
                type: 'trigger',
                position,
                trigger_kind: 'manual',
                instructions: 'Describe what the agent should do when fired',
            };
            return node;
        }
        case 'native_agent': {
            const node: NativeAgentNode = {
                id,
                type: 'native_agent',
                position,
                l1_graph_id: '',
            };
            return node;
        }
        case 'cli_agent': {
            const node: CliAgentNode = {
                id,
                type: 'cli_agent',
                position,
                command: 'go-claude',
                session_mode: 'session-aware',
            };
            return node;
        }
        case 'pi_agent': {
            const node: PiAgentNode = {
                id,
                type: 'pi_agent',
                position,
                session_mode: 'session-aware',
            };
            return node;
        }
        case 'memory': {
            const node: MemoryNode = {
                id,
                type: 'memory',
                position,
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'last_n',
                tool_access: 'none',
            };
            return node;
        }
        case 'handler_input': {
            const node: HandlerInputNode = { id, type: 'handler_input', position };
            return node;
        }
        case 'handler_output': {
            const node: HandlerOutputNode = { id, type: 'handler_output', position };
            return node;
        }
        case 'prompt_builder': {
            const node: PromptBuilderNode = { id, type: 'prompt_builder', position };
            return node;
        }
        case 'model_call': {
            const node: ModelCallNode = { id, type: 'model_call', position };
            return node;
        }
        case 'tool_exec': {
            const node: ToolExecNode = { id, type: 'tool_exec', position };
            return node;
        }
        case 'evaluator': {
            const node: EvaluatorNode = { id, type: 'evaluator', position };
            return node;
        }
        case 'cli_invocation_target': {
            const node: CliInvocationTargetNode = {
                id,
                type: 'cli_invocation_target',
                position,
            };
            return node;
        }
        case 'debug_gateway': {
            const node: DebugGatewayNode = { id, type: 'debug_gateway', position };
            return node;
        }
        case 'debug_probe': {
            const node: DebugProbeNode = { id, type: 'debug_probe', position };
            return node;
        }
        case 'permission': {
            const node: PermissionNode = { id, type: 'permission', position };
            return node;
        }
        case 'checkpoint': {
            const node: CheckpointNode = {
                id,
                type: 'checkpoint',
                position,
                strategy: 'supervisor',
                cadence: { kind: 'iterations', at: [] },
                agent_id: '',
            };
            return node;
        }
    }
}

export function buildSavedRefNode(
    savedKind: SavedRefKind,
    savedId: string,
    savedName: string,
    position: Position,
    instantiatedFrom?: string,
    savedDescription?: string,
): Node {
    const trimmed = savedName.trim();
    const name = trimmed.length > 0 ? trimmed : undefined;
    const trimmedDesc = savedDescription?.trim();
    const description = trimmedDesc && trimmedDesc.length > 0 ? trimmedDesc : undefined;
    const provenance = instantiatedFrom ? { instantiated_from: instantiatedFrom } : {};
    switch (savedKind) {
        case 'toolpack': {
            const id = nextNodeId('tool_pack');
            const node: ToolPackNode = {
                id,
                type: 'tool_pack',
                position,
                ref_id: savedId,
                ...(name ? { pack_name: name } : {}),
                ...provenance,
            };
            return node;
        }
        case 'skillpack': {
            const id = nextNodeId('skill_pack');
            const node: SkillPackNode = {
                id,
                type: 'skill_pack',
                position,
                ref_id: savedId,
                ...(name ? { pack_name: name } : {}),
                ...provenance,
            };
            return node;
        }
        case 'handler': {
            const id = nextNodeId('handler');
            const node: HandlerNode = {
                id,
                type: 'handler',
                position,
                ref_id: savedId,
                ...provenance,
            };
            return node;
        }
        case 'l1': {
            const id = nextNodeId('native_agent');
            const node: NativeAgentNode = {
                id,
                type: 'native_agent',
                position,
                l1_graph_id: savedId,
                ...(name ? { display_name: name } : {}),
                ...(description ? { description } : {}),
                ...provenance,
            };
            return node;
        }
    }
}

const PRESET_UNSAVABLE_TYPES: ReadonlySet<Node['type']> = new Set<Node['type']>([
    'handler',
    'tool_pack',
    'skill_pack',
    'native_agent',
    'cli_agent',
    'pi_agent',
    'debug_probe',
]);

export function isPresetSavable(node: Node): boolean {
    return !PRESET_UNSAVABLE_TYPES.has(node.type);
}

export function suggestPresetName(node: Node): string {
    switch (node.type) {
        case 'model':
            return node.model_id || node.type;
        case 'tool':
            return node.tool_name || node.type;
        case 'skill':
            return node.name || node.type;
        case 'workspace': {
            const last = node.path.split('/').filter(Boolean).at(-1);
            return last ?? node.type;
        }
        case 'channel':
            return node.channel_kind || node.type;
        case 'trigger':
            return node.trigger_kind || node.type;
        default:
            return node.type;
    }
}

export function savedRefKindsForGraphKind(kind: GraphKind): ReadonlySet<SavedRefKind> {
    switch (kind) {
        case 'l1':
            return new Set<SavedRefKind>(['toolpack', 'skillpack', 'handler']);
        case 'l2':
            return new Set<SavedRefKind>(['l1']);
        default:
            return new Set<SavedRefKind>();
    }
}

function nodeRefTarget(node: Node): string | undefined {
    return (node as { l1_graph_id?: string }).l1_graph_id ?? (node as { ref_id?: string }).ref_id;
}

export function hiddenFragmentRefIds(
    entries: ReadonlyArray<{ id?: string; nodes: Node[]; fragment?: boolean }>,
): Set<string> {
    const byId = new Map<string, { id?: string; nodes: Node[]; fragment?: boolean }>();
    for (const e of entries) {
        if (e.id) byId.set(e.id, e);
    }
    const hidden = new Set<string>();
    const queue: string[] = [];
    for (const entry of entries) {
        if (entry.fragment !== true) continue;
        for (const node of entry.nodes) {
            const target = nodeRefTarget(node);
            if (target) queue.push(target);
        }
    }
    while (queue.length > 0) {
        const id = queue.pop()!;
        if (hidden.has(id)) continue;
        hidden.add(id);
        const entry = byId.get(id);
        if (!entry) continue;
        for (const node of entry.nodes) {
            const target = nodeRefTarget(node);
            if (target && !hidden.has(target)) queue.push(target);
        }
    }
    return hidden;
}

export type LibraryDropClass =
    | { kind: 'wrapper'; savedKind: SavedRefKind }
    | { kind: 'leaf'; leafType: Node['type'] }
    | { kind: 'inline-multi' };

export function classifyLibraryEntry(
    entry: { kind: GraphKind; nodes: Node[]; fragment?: boolean },
    graphKind: GraphKind,
): LibraryDropClass | null {
    if (entry.fragment === true) {
        return entry.kind === graphKind ? { kind: 'inline-multi' } : null;
    }
    const nodes = entry.nodes;
    if (nodes.length === 1 && isPresetSavable(nodes[0]!)) {
        const lone = nodes[0]!;
        const leafTypes = paletteKindsForGraphKind(graphKind);
        if ((leafTypes as ReadonlySet<string>).has(lone.type)) {
            return { kind: 'leaf', leafType: lone.type };
        }
        // Fall through to the wrapper check for the (unusual) case where a
        // single-node graph's kind matches a wrapper row but the lone type
        // isn't allowed inline.
    }
    if (nodes.length > 1 && entry.kind === graphKind) {
        return { kind: 'inline-multi' };
    }
    const wrapperKinds = savedRefKindsForGraphKind(graphKind);
    if ((wrapperKinds as ReadonlySet<string>).has(entry.kind)) {
        return { kind: 'wrapper', savedKind: entry.kind as SavedRefKind };
    }
    return null;
}
