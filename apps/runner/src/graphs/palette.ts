import type {
    CompositeKindSpec,
    ConnectionRule,
    GraphKind,
    NodeType,
    Palette,
    PaletteNodeSpec,
    PortDef,
} from '@fabritorio/types';

const HANDLER_PORTS = {
    toolsIn: { id: 'tools-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
    gatewayIn: { id: 'gateway-in', kind: 'event', direction: 'in' },
    modelOut: { id: 'model-out', kind: 'reference', direction: 'out' },
    outputOut: { id: 'output-out', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const MODEL_PORTS = {
    toolsIn: { id: 'tools-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
    gatewayIn: { id: 'gateway-in', kind: 'event', direction: 'in' },
    modelIn: { id: 'model-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortDef>;

const TOOL_PORTS = {
    toolOut: { id: 'tool-out', kind: 'reference', direction: 'out' },
    secretsIn: { id: 'tool-secrets-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortDef>;

const TOOL_PACK_PORTS = {
    toolOut: { id: 'tool-out', kind: 'reference', direction: 'out' },
    secretsIn: { id: 'tool-pack-secrets-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortDef>;

const PERMISSION_PORTS = {
    toolsIn: { id: 'permission-tools-in', kind: 'reference', direction: 'in' },
    toolsOut: { id: 'permission-tools-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const CHECKPOINT_PORTS = {
    handlerOut: { id: 'checkpoint-handler-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const SKILL_PORTS = {
    skillOut: { id: 'skill-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const WORKSPACE_PORTS = {
    workspaceOut: { id: 'workspace-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const SECRETS_PORTS = {
    secretsOut: { id: 'secrets-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const GATEWAY_PORTS = {
    gatewayIn: { id: 'gateway-in', kind: 'event', direction: 'in' },
    gatewayOut: { id: 'gateway-out', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const OUTPUT_PORTS = {
    outputIn: { id: 'output-in', kind: 'event', direction: 'in' },
    resultOut: { id: 'result', kind: 'event', direction: 'out' },
    errorOut: { id: 'error', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const CHANNEL_PORTS = {
    out: { id: 'channel-out', kind: 'event', direction: 'out' },
    in: { id: 'channel-in', kind: 'event', direction: 'in' },
} as const satisfies Record<string, PortDef>;

const TRIGGER_PORTS = {
    out: { id: 'trigger-out', kind: 'event', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const DEBUG_GATEWAY_PORTS = {
    out: { id: 'debug-out', kind: 'event', direction: 'out' },
    in: { id: 'debug-in', kind: 'event', direction: 'in' },
} as const satisfies Record<string, PortDef>;

const DEBUG_PROBE_PORTS = {
    attachOut: { id: 'probe-attach-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const NATIVE_AGENT_PORTS = {
    gatewayIn: { id: 'agent-gateway-in', kind: 'event', direction: 'in' },
    outputOut: { id: 'agent-output-out', kind: 'event', direction: 'out' },
    memoryIn: { id: 'memory-in', kind: 'reference', direction: 'in' },
    skillsIn: { id: 'skills-in', kind: 'reference', direction: 'in' },
    workspaceIn: { id: 'workspace-in', kind: 'reference', direction: 'in' },
} as const satisfies Record<string, PortDef>;

const MEMORY_PORTS = {
    out: { id: 'memory-out', kind: 'reference', direction: 'out' },
} as const satisfies Record<string, PortDef>;

const HANDLER_NODE: PaletteNodeSpec = {
    inPorts: [
        HANDLER_PORTS.toolsIn,
        HANDLER_PORTS.skillsIn,
        HANDLER_PORTS.workspaceIn,
        HANDLER_PORTS.gatewayIn,
    ],
    outPorts: [HANDLER_PORTS.modelOut, HANDLER_PORTS.outputOut],
    requiredFields: [],
    defaultedFields: ['max_iterations'],
};

const MODEL_NODE: PaletteNodeSpec = {
    inPorts: [
        MODEL_PORTS.toolsIn,
        MODEL_PORTS.skillsIn,
        MODEL_PORTS.workspaceIn,
        MODEL_PORTS.gatewayIn,
        MODEL_PORTS.modelIn,
    ],
    outPorts: [],
    requiredFields: ['provider', 'model_id'],
    defaultedFields: ['temperature'],
};

const TOOL_NODE: PaletteNodeSpec = {
    inPorts: [TOOL_PORTS.secretsIn],
    outPorts: [TOOL_PORTS.toolOut],
    requiredFields: ['tool_name'],
    defaultedFields: [],
};

const TOOL_PACK_NODE: PaletteNodeSpec = {
    inPorts: [TOOL_PACK_PORTS.secretsIn],
    outPorts: [TOOL_PACK_PORTS.toolOut],
    requiredFields: ['ref_id'],
    defaultedFields: [],
};

const SKILL_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [SKILL_PORTS.skillOut],
    requiredFields: ['name'],
    defaultedFields: [],
};

const SKILL_PACK_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [SKILL_PORTS.skillOut],
    requiredFields: ['ref_id'],
    defaultedFields: [],
};

const WORKSPACE_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [WORKSPACE_PORTS.workspaceOut],
    requiredFields: ['path'],
    defaultedFields: [],
};

const GATEWAY_NODE: PaletteNodeSpec = {
    inPorts: [GATEWAY_PORTS.gatewayIn],
    outPorts: [GATEWAY_PORTS.gatewayOut],
    requiredFields: [],
    defaultedFields: [],
};

const OUTPUT_NODE: PaletteNodeSpec = {
    inPorts: [OUTPUT_PORTS.outputIn],
    outPorts: [OUTPUT_PORTS.resultOut, OUTPUT_PORTS.errorOut],
    requiredFields: [],
    defaultedFields: [],
};

const PERMISSION_NODE: PaletteNodeSpec = {
    inPorts: [PERMISSION_PORTS.toolsIn],
    outPorts: [PERMISSION_PORTS.toolsOut],
    requiredFields: [],
    defaultedFields: ['strategy'],
};

const CHECKPOINT_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [CHECKPOINT_PORTS.handlerOut],
    requiredFields: ['strategy', 'cadence', 'agent_id'],
    defaultedFields: [],
};

const CHANNEL_NODE: PaletteNodeSpec = {
    inPorts: [CHANNEL_PORTS.in],
    outPorts: [CHANNEL_PORTS.out],
    requiredFields: [],
    defaultedFields: [],
};

const TRIGGER_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [TRIGGER_PORTS.out],
    requiredFields: ['trigger_kind'],
    defaultedFields: [],
};

const NATIVE_AGENT_NODE: PaletteNodeSpec = {
    inPorts: [
        NATIVE_AGENT_PORTS.gatewayIn,
        NATIVE_AGENT_PORTS.memoryIn,
        NATIVE_AGENT_PORTS.skillsIn,
        NATIVE_AGENT_PORTS.workspaceIn,
    ],
    outPorts: [NATIVE_AGENT_PORTS.outputOut],
    requiredFields: ['l1_graph_id'],
    defaultedFields: [],
};

const MEMORY_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [MEMORY_PORTS.out],
    requiredFields: ['handling'],
    defaultedFields: ['n', 'token_budget'],
};

const DEBUG_GATEWAY_NODE: PaletteNodeSpec = {
    inPorts: [DEBUG_GATEWAY_PORTS.in],
    outPorts: [DEBUG_GATEWAY_PORTS.out],
    requiredFields: [],
    defaultedFields: ['mode'],
};

const DEBUG_PROBE_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [DEBUG_PROBE_PORTS.attachOut],
    requiredFields: [],
    defaultedFields: ['haltOn', 'enabled'],
};

const MODEL_ROUTER_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [],
    requiredFields: [],
    defaultedFields: [],
};

const HANDLER_INPUT_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [{ id: 'handler-input-out', kind: 'event', direction: 'out' }],
    requiredFields: [],
    defaultedFields: [],
};

const HANDLER_OUTPUT_NODE: PaletteNodeSpec = {
    inPorts: [{ id: 'handler-output-in', kind: 'event', direction: 'in' }],
    outPorts: [],
    requiredFields: [],
    defaultedFields: [],
};

const PROMPT_BUILDER_NODE: PaletteNodeSpec = {
    inPorts: [{ id: 'prompt-builder-in', kind: 'event', direction: 'in' }],
    outPorts: [{ id: 'prompt-builder-out', kind: 'event', direction: 'out' }],
    requiredFields: [],
    defaultedFields: [],
};

const MODEL_CALL_NODE: PaletteNodeSpec = {
    inPorts: [{ id: 'model-call-in', kind: 'event', direction: 'in' }],
    outPorts: [{ id: 'model-call-out', kind: 'event', direction: 'out' }],
    requiredFields: [],
    defaultedFields: [],
};

const TOOL_EXEC_NODE: PaletteNodeSpec = {
    inPorts: [{ id: 'tool-exec-in', kind: 'event', direction: 'in' }],
    outPorts: [{ id: 'tool-exec-out', kind: 'event', direction: 'out' }],
    requiredFields: [],
    defaultedFields: [],
};

const EVALUATOR_NODE: PaletteNodeSpec = {
    inPorts: [{ id: 'evaluator-in', kind: 'event', direction: 'in' }],
    outPorts: [{ id: 'evaluator-out', kind: 'event', direction: 'out' }],
    requiredFields: [],
    defaultedFields: [],
};

const SECRETS_NODE: PaletteNodeSpec = {
    inPorts: [],
    outPorts: [SECRETS_PORTS.secretsOut],
    requiredFields: [],
    defaultedFields: ['bindings'],
};

const NODE_SPECS: Record<NodeType, PaletteNodeSpec> = {
    handler: HANDLER_NODE,
    model: MODEL_NODE,
    model_router: MODEL_ROUTER_NODE,
    tool: TOOL_NODE,
    tool_pack: TOOL_PACK_NODE,
    skill: SKILL_NODE,
    skill_pack: SKILL_PACK_NODE,
    workspace: WORKSPACE_NODE,
    gateway: GATEWAY_NODE,
    output: OUTPUT_NODE,
    permission: PERMISSION_NODE,
    checkpoint: CHECKPOINT_NODE,
    secrets: SECRETS_NODE,
    channel: CHANNEL_NODE,
    trigger: TRIGGER_NODE,
    native_agent: NATIVE_AGENT_NODE,
    memory: MEMORY_NODE,
    debug_gateway: DEBUG_GATEWAY_NODE,
    debug_probe: DEBUG_PROBE_NODE,
    handler_input: HANDLER_INPUT_NODE,
    handler_output: HANDLER_OUTPUT_NODE,
    prompt_builder: PROMPT_BUILDER_NODE,
    model_call: MODEL_CALL_NODE,
    tool_exec: TOOL_EXEC_NODE,
    evaluator: EVALUATOR_NODE,
};

interface PairOpts {
    sourcePort?: string;
    targetPort?: string;
    decorative?: boolean;
    errorMessage?: string;
}

function pair(source: NodeType, target: NodeType, opts: PairOpts = {}): ConnectionRule {
    const rule: ConnectionRule = { source, target };
    if (opts.sourcePort) rule.sourcePort = opts.sourcePort;
    if (opts.targetPort) rule.targetPort = opts.targetPort;
    if (opts.decorative) rule.decorative = true;
    if (opts.errorMessage) rule.errorMessage = opts.errorMessage;
    return rule;
}

const L1_SKILL_MSG = 'Skill must connect to a Handler or Model';
const L1_SKILL_PACK_MSG = 'Skill Pack must connect to a Handler or Model';
const L1_TOOL_MSG = 'Tool must connect to a Handler, Model, or Permission gate';
const L1_TOOL_PACK_MSG = 'Tool Pack must connect to a Handler, Model, or Permission gate';
const L1_WORKSPACE_MSG = 'Workspace must connect to a Handler or Model';
const L1_PERMISSION_MSG = 'Permission gate must connect to the Handler';
const L1_CHECKPOINT_MSG = 'Checkpoint must connect to the Handler';
const L1_SECRETS_MSG = 'Secrets must connect to a Tool or Tool Pack';
const L1_GATEWAY_MSG = 'Gateway must connect to a Handler or Model';
const L1_DEBUG_GATEWAY_MSG = 'Debug Gateway must connect to the Handler';
const L1_HANDLER_MSG = 'Handler only connects out to a Model, Model Router, or Output';
const L1_MODEL_ROUTER_MSG = 'Model Router connects out to a Model or another Model Router';

const L1_CONNECTIONS: ConnectionRule[] = [
    pair('skill', 'handler', {
        sourcePort: SKILL_PORTS.skillOut.id,
        targetPort: HANDLER_PORTS.skillsIn.id,
        errorMessage: L1_SKILL_MSG,
    }),
    pair('skill_pack', 'handler', {
        sourcePort: SKILL_PORTS.skillOut.id,
        targetPort: HANDLER_PORTS.skillsIn.id,
        errorMessage: L1_SKILL_PACK_MSG,
    }),
    pair('tool', 'handler', {
        sourcePort: TOOL_PORTS.toolOut.id,
        targetPort: HANDLER_PORTS.toolsIn.id,
        errorMessage: L1_TOOL_MSG,
    }),
    pair('tool_pack', 'handler', {
        sourcePort: TOOL_PACK_PORTS.toolOut.id,
        targetPort: HANDLER_PORTS.toolsIn.id,
        errorMessage: L1_TOOL_PACK_MSG,
    }),
    pair('workspace', 'handler', {
        sourcePort: WORKSPACE_PORTS.workspaceOut.id,
        targetPort: HANDLER_PORTS.workspaceIn.id,
        errorMessage: L1_WORKSPACE_MSG,
    }),
    pair('permission', 'handler', {
        sourcePort: PERMISSION_PORTS.toolsOut.id,
        targetPort: HANDLER_PORTS.toolsIn.id,
        errorMessage: L1_PERMISSION_MSG,
    }),
    pair('checkpoint', 'handler', {
        sourcePort: CHECKPOINT_PORTS.handlerOut.id,
        targetPort: HANDLER_PORTS.toolsIn.id,
        errorMessage: L1_CHECKPOINT_MSG,
    }),
    pair('tool', 'permission', {
        sourcePort: TOOL_PORTS.toolOut.id,
        targetPort: PERMISSION_PORTS.toolsIn.id,
        errorMessage: L1_TOOL_MSG,
    }),
    pair('tool_pack', 'permission', {
        sourcePort: TOOL_PACK_PORTS.toolOut.id,
        targetPort: PERMISSION_PORTS.toolsIn.id,
        errorMessage: L1_TOOL_PACK_MSG,
    }),
    pair('secrets', 'tool', {
        sourcePort: SECRETS_PORTS.secretsOut.id,
        targetPort: TOOL_PORTS.secretsIn.id,
        errorMessage: L1_SECRETS_MSG,
    }),
    pair('secrets', 'tool_pack', {
        sourcePort: SECRETS_PORTS.secretsOut.id,
        targetPort: TOOL_PACK_PORTS.secretsIn.id,
        errorMessage: L1_SECRETS_MSG,
    }),
    pair('gateway', 'handler', {
        sourcePort: GATEWAY_PORTS.gatewayOut.id,
        targetPort: HANDLER_PORTS.gatewayIn.id,
        errorMessage: L1_GATEWAY_MSG,
    }),
    pair('debug_gateway', 'handler', {
        sourcePort: DEBUG_GATEWAY_PORTS.out.id,
        targetPort: HANDLER_PORTS.gatewayIn.id,
        errorMessage: L1_DEBUG_GATEWAY_MSG,
    }),
    pair('handler', 'model', {
        sourcePort: HANDLER_PORTS.modelOut.id,
        targetPort: MODEL_PORTS.modelIn.id,
        errorMessage: L1_HANDLER_MSG,
    }),
    pair('handler', 'model_router', {
        sourcePort: HANDLER_PORTS.modelOut.id,
        errorMessage: L1_HANDLER_MSG,
    }),
    pair('handler', 'output', {
        sourcePort: HANDLER_PORTS.outputOut.id,
        targetPort: OUTPUT_PORTS.outputIn.id,
        errorMessage: L1_HANDLER_MSG,
    }),
    pair('model_router', 'model', { errorMessage: L1_MODEL_ROUTER_MSG }),
    pair('model_router', 'model_router', { errorMessage: L1_MODEL_ROUTER_MSG }),
    pair('skill', 'model', {
        sourcePort: SKILL_PORTS.skillOut.id,
        targetPort: MODEL_PORTS.skillsIn.id,
        errorMessage: L1_SKILL_MSG,
    }),
    pair('skill_pack', 'model', {
        sourcePort: SKILL_PORTS.skillOut.id,
        targetPort: MODEL_PORTS.skillsIn.id,
        errorMessage: L1_SKILL_PACK_MSG,
    }),
    pair('tool', 'model', {
        sourcePort: TOOL_PORTS.toolOut.id,
        targetPort: MODEL_PORTS.toolsIn.id,
        errorMessage: L1_TOOL_MSG,
    }),
    pair('tool_pack', 'model', {
        sourcePort: TOOL_PACK_PORTS.toolOut.id,
        targetPort: MODEL_PORTS.toolsIn.id,
        errorMessage: L1_TOOL_PACK_MSG,
    }),
    pair('workspace', 'model', {
        sourcePort: WORKSPACE_PORTS.workspaceOut.id,
        targetPort: MODEL_PORTS.workspaceIn.id,
        errorMessage: L1_WORKSPACE_MSG,
    }),
    pair('gateway', 'model', {
        sourcePort: GATEWAY_PORTS.gatewayOut.id,
        targetPort: MODEL_PORTS.gatewayIn.id,
        errorMessage: L1_GATEWAY_MSG,
    }),
];

const L2_AGENT_TYPES: NodeType[] = ['native_agent'];

const L2_CHANNEL_MSG = 'Channel publishes to a NativeAgent';
const L2_TRIGGER_MSG = 'Trigger publishes to a NativeAgent';
const L2_DEBUG_GATEWAY_MSG = 'Debug Gateway publishes to a NativeAgent';
const L2_AGENT_MSG = 'Agent must target a Channel, Debug Gateway, or another Agent';
const L2_MEMORY_MSG = 'Memory only attaches to NativeAgent';

const L2_CONNECTIONS: ConnectionRule[] = [
    ...L2_AGENT_TYPES.flatMap((agent) => [
        pair('channel', agent, {
            sourcePort: CHANNEL_PORTS.out.id,
            targetPort: NATIVE_AGENT_PORTS.gatewayIn.id,
            errorMessage: L2_CHANNEL_MSG,
        }),
        pair('trigger', agent, {
            sourcePort: TRIGGER_PORTS.out.id,
            targetPort: NATIVE_AGENT_PORTS.gatewayIn.id,
            errorMessage: L2_TRIGGER_MSG,
        }),
        pair('debug_gateway', agent, {
            sourcePort: DEBUG_GATEWAY_PORTS.out.id,
            targetPort: NATIVE_AGENT_PORTS.gatewayIn.id,
            errorMessage: L2_DEBUG_GATEWAY_MSG,
        }),
    ]),
    ...L2_AGENT_TYPES.flatMap((agent) => [
        pair(agent, 'channel', {
            sourcePort: NATIVE_AGENT_PORTS.outputOut.id,
            targetPort: CHANNEL_PORTS.in.id,
            errorMessage: L2_AGENT_MSG,
        }),
        pair(agent, 'debug_gateway', {
            sourcePort: NATIVE_AGENT_PORTS.outputOut.id,
            targetPort: DEBUG_GATEWAY_PORTS.in.id,
            errorMessage: L2_AGENT_MSG,
        }),
        ...L2_AGENT_TYPES.map((target) =>
            pair(agent, target, {
                sourcePort: NATIVE_AGENT_PORTS.outputOut.id,
                targetPort: NATIVE_AGENT_PORTS.gatewayIn.id,
                errorMessage: L2_AGENT_MSG,
            }),
        ),
    ]),
    ...L2_AGENT_TYPES.map((agent) =>
        pair('memory', agent, {
            sourcePort: MEMORY_PORTS.out.id,
            targetPort: NATIVE_AGENT_PORTS.memoryIn.id,
            errorMessage: L2_MEMORY_MSG,
        }),
    ),
];

const HANDLER_PRIMS: NodeType[] = [
    'handler_input',
    'handler_output',
    'prompt_builder',
    'model_call',
    'tool_exec',
    'evaluator',
];

const HANDLER_PRIM_MSG = 'Handler graph only accepts handler primitive nodes';

const HANDLER_CONNECTIONS: ConnectionRule[] = HANDLER_PRIMS.flatMap((source) =>
    HANDLER_PRIMS.map((target) => pair(source, target, { errorMessage: HANDLER_PRIM_MSG })),
).filter(
    (rule) =>
        rule.target !== 'handler_input' &&
        rule.source !== 'handler_output' &&
        rule.source !== rule.target,
);

const TOOLPACK_MSG = 'Tool pack only accepts Tool or Tool Pack nodes';
const TOOLPACK_CONNECTIONS: ConnectionRule[] = [
    pair('tool', 'tool', { decorative: true, errorMessage: TOOLPACK_MSG }),
    pair('tool', 'tool_pack', { decorative: true, errorMessage: TOOLPACK_MSG }),
    pair('tool_pack', 'tool', { decorative: true, errorMessage: TOOLPACK_MSG }),
    pair('tool_pack', 'tool_pack', { decorative: true, errorMessage: TOOLPACK_MSG }),
];

const SKILLPACK_MSG = 'Skill pack only accepts Skill or Skill Pack nodes';
const SKILLPACK_CONNECTIONS: ConnectionRule[] = [
    pair('skill', 'skill', { decorative: true, errorMessage: SKILLPACK_MSG }),
    pair('skill', 'skill_pack', { decorative: true, errorMessage: SKILLPACK_MSG }),
    pair('skill_pack', 'skill', { decorative: true, errorMessage: SKILLPACK_MSG }),
    pair('skill_pack', 'skill_pack', { decorative: true, errorMessage: SKILLPACK_MSG }),
];

const TOOLPACK_KIND: CompositeKindSpec = {
    allowedNodeTypes: ['tool', 'tool_pack'],
    decorativeEdges: true,
};

const SKILLPACK_KIND: CompositeKindSpec = {
    allowedNodeTypes: ['skill', 'skill_pack'],
    decorativeEdges: true,
};

const HANDLER_KIND: CompositeKindSpec = {
    allowedNodeTypes: [
        'handler_input',
        'handler_output',
        'prompt_builder',
        'model_call',
        'tool_exec',
        'evaluator',
    ],
};

const L1_KIND: CompositeKindSpec = {
    allowedNodeTypes: [
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
    ],
    topology: { singleGateway: true, requireOutput: true },
};

const L2_KIND: CompositeKindSpec = {
    allowedNodeTypes: [
        'channel',
        'trigger',
        'native_agent',
        'memory',
        'debug_gateway',
        'debug_probe',
    ],
};

export const PALETTE_VERSION = 1;

export const palette: Palette = {
    version: PALETTE_VERSION,
    nodes: NODE_SPECS,
    connections: {
        toolpack: TOOLPACK_CONNECTIONS,
        skillpack: SKILLPACK_CONNECTIONS,
        handler: HANDLER_CONNECTIONS,
        l1: L1_CONNECTIONS,
        l2: L2_CONNECTIONS,
    },
    compositeKinds: {
        toolpack: TOOLPACK_KIND,
        skillpack: SKILLPACK_KIND,
        handler: HANDLER_KIND,
        l1: L1_KIND,
        l2: L2_KIND,
    },
};

export function paletteNodeSpec(type: NodeType): PaletteNodeSpec {
    return (
        palette.nodes[type] ?? {
            inPorts: [],
            outPorts: [],
            requiredFields: [],
            defaultedFields: [],
        }
    );
}

export function findConnectionRule(
    kind: GraphKind,
    source: NodeType,
    target: NodeType,
): ConnectionRule | null {
    const rules = palette.connections[kind] ?? [];
    for (const rule of rules) {
        if (rule.source === source && rule.target === target) return rule;
    }
    return null;
}

export function findRuleBySource(kind: GraphKind, sourceType: NodeType): ConnectionRule | null {
    const rules = palette.connections[kind] ?? [];
    for (const rule of rules) {
        if (rule.source === sourceType) return rule;
    }
    return null;
}

export function findRuleByTarget(kind: GraphKind, targetType: NodeType): ConnectionRule | null {
    const rules = palette.connections[kind] ?? [];
    for (const rule of rules) {
        if (rule.target === targetType) return rule;
    }
    return null;
}
