export type Kind =
    | 'model'
    | 'model_router'
    | 'gateway'
    | 'output'
    | 'skill'
    | 'tool'
    | 'tool_pack'
    | 'workspace'
    | 'handler'
    | 'channel'
    | 'trigger'
    | 'native_agent'
    | 'cli_agent'
    | 'pi_agent'
    | 'memory'
    | 'handler_input'
    | 'handler_output'
    | 'prompt_builder'
    | 'model_call'
    | 'tool_exec'
    | 'evaluator'
    | 'cli_invocation_target'
    | 'debug_gateway'
    | 'debug_probe'
    | 'permission'
    | 'checkpoint'
    | 'secrets';

export type ColorKind = Kind | 'schedule' | 'manual' | 'skill_pack';

export type Surface = 'node' | 'palette';
type Step = 1 | 2 | 3;

const HUE_CLASSES: Record<string, Partial<Record<Step, Record<Surface, string>>>> = {
    amber: {
        1: {
            node: 'border-amber-300 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-500/15',
            palette:
                'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200',
        },
        2: {
            node: 'border-amber-400 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-500/15',
            palette:
                'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200',
        },
        3: {
            node: 'border-amber-500 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-500/15',
            palette:
                'border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200',
        },
    },
    emerald: {
        1: {
            node: 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-500/15',
            palette:
                'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-200',
        },
        2: {
            node: 'border-emerald-400 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-500/15',
            palette:
                'border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-200',
        },
    },
    indigo: {
        1: {
            node: 'border-indigo-300 bg-indigo-50 dark:border-indigo-500/60 dark:bg-indigo-500/15',
            palette:
                'border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-400/40 dark:bg-indigo-500/10 dark:text-indigo-200',
        },
        2: {
            node: 'border-indigo-400 bg-indigo-50 dark:border-indigo-500/60 dark:bg-indigo-500/15',
            palette:
                'border-indigo-400 bg-indigo-50 text-indigo-900 dark:border-indigo-400/40 dark:bg-indigo-500/10 dark:text-indigo-200',
        },
    },
    orange: {
        1: {
            node: 'border-orange-300 bg-orange-50 dark:border-orange-500/60 dark:bg-orange-500/15',
            palette:
                'border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-400/40 dark:bg-orange-500/10 dark:text-orange-200',
        },
        2: {
            node: 'border-orange-400 bg-orange-50 dark:border-orange-500/60 dark:bg-orange-500/15',
            palette:
                'border-orange-400 bg-orange-50 text-orange-900 dark:border-orange-400/40 dark:bg-orange-500/10 dark:text-orange-200',
        },
    },
    purple: {
        1: {
            node: 'border-purple-300 bg-purple-50 dark:border-purple-500/60 dark:bg-purple-500/15',
            palette:
                'border-purple-300 bg-purple-50 text-purple-900 dark:border-purple-400/40 dark:bg-purple-500/10 dark:text-purple-200',
        },
        2: {
            node: 'border-purple-400 bg-purple-50 dark:border-purple-500/60 dark:bg-purple-500/15',
            palette:
                'border-purple-400 bg-purple-50 text-purple-900 dark:border-purple-400/40 dark:bg-purple-500/10 dark:text-purple-200',
        },
    },
    rose: {
        1: {
            node: 'border-rose-300 bg-rose-50 dark:border-rose-500/60 dark:bg-rose-500/15',
            palette:
                'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-400/40 dark:bg-rose-500/10 dark:text-rose-200',
        },
        2: {
            node: 'border-rose-400 bg-rose-50 dark:border-rose-500/60 dark:bg-rose-500/15',
            palette:
                'border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-400/40 dark:bg-rose-500/10 dark:text-rose-200',
        },
    },
    fuchsia: {
        1: {
            node: 'border-fuchsia-300 bg-fuchsia-50 dark:border-fuchsia-500/60 dark:bg-fuchsia-500/15',
            palette:
                'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900 dark:border-fuchsia-400/40 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
        },
        2: {
            node: 'border-fuchsia-400 bg-fuchsia-50 dark:border-fuchsia-500/60 dark:bg-fuchsia-500/15',
            palette:
                'border-fuchsia-400 bg-fuchsia-50 text-fuchsia-900 dark:border-fuchsia-400/40 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
        },
    },
    cyan: {
        1: {
            node: 'border-cyan-300 bg-cyan-50 dark:border-cyan-500/60 dark:bg-cyan-500/15',
            palette:
                'border-cyan-300 bg-cyan-50 text-cyan-900 dark:border-cyan-400/40 dark:bg-cyan-500/10 dark:text-cyan-200',
        },
    },
    violet: {
        1: {
            node: 'border-violet-300 bg-violet-50 dark:border-violet-500/60 dark:bg-violet-500/15',
            palette:
                'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-400/40 dark:bg-violet-500/10 dark:text-violet-200',
        },
    },
    red: {
        1: {
            node: 'border-red-300 bg-red-50 dark:border-red-500/60 dark:bg-red-500/15',
            palette:
                'border-red-300 bg-red-50 text-red-900 dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-200',
        },
    },
    slate: {
        1: {
            node: 'border-slate-300 bg-slate-50 dark:border-slate-500/60 dark:bg-slate-500/15',
            palette:
                'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-400/40 dark:bg-slate-500/10 dark:text-slate-200',
        },
    },
    pink: {
        1: {
            node: 'border-pink-300 bg-pink-50 dark:border-pink-500/60 dark:bg-pink-500/15',
            palette:
                'border-pink-300 bg-pink-50 text-pink-900 dark:border-pink-400/40 dark:bg-pink-500/10 dark:text-pink-200',
        },
    },
};

const FAMILY_HUE = {
    agent: 'amber',
    boundary: 'emerald',
    model: 'indigo',
    tool: 'orange',
    skill: 'purple',
    control: 'amber',
    trigger: 'rose',
    debug: 'fuchsia',
    workspace: 'cyan',
    memory: 'violet',
    permission: 'red',
    secrets: 'slate',
    prompt: 'pink',
} as const;

const KIND: Record<ColorKind, { family: keyof typeof FAMILY_HUE; step: Step }> = {
    native_agent: { family: 'agent', step: 1 },
    cli_agent: { family: 'agent', step: 2 },
    pi_agent: { family: 'agent', step: 3 },
    cli_invocation_target: { family: 'agent', step: 2 },
    gateway: { family: 'boundary', step: 1 },
    output: { family: 'boundary', step: 2 },
    channel: { family: 'boundary', step: 1 },
    handler_input: { family: 'boundary', step: 1 },
    handler_output: { family: 'boundary', step: 2 },
    model: { family: 'model', step: 1 },
    model_router: { family: 'model', step: 2 },
    model_call: { family: 'model', step: 1 },
    tool: { family: 'tool', step: 1 },
    tool_exec: { family: 'tool', step: 1 },
    tool_pack: { family: 'tool', step: 2 },
    skill: { family: 'skill', step: 1 },
    skill_pack: { family: 'skill', step: 2 },
    handler: { family: 'control', step: 1 },
    evaluator: { family: 'control', step: 2 },
    checkpoint: { family: 'control', step: 2 },
    trigger: { family: 'trigger', step: 1 },
    schedule: { family: 'trigger', step: 2 },
    manual: { family: 'trigger', step: 2 },
    debug_gateway: { family: 'debug', step: 1 },
    debug_probe: { family: 'debug', step: 2 },
    workspace: { family: 'workspace', step: 1 },
    memory: { family: 'memory', step: 1 },
    permission: { family: 'permission', step: 1 },
    secrets: { family: 'secrets', step: 1 },
    prompt_builder: { family: 'prompt', step: 1 },
};

export type Family = keyof typeof FAMILY_HUE;

export function nodeFamily(kind: ColorKind): Family {
    return KIND[kind].family;
}

export function kindColorClasses(kind: ColorKind, surface: Surface): string {
    const { family, step } = KIND[kind];
    const hue = FAMILY_HUE[family];
    const cell = HUE_CLASSES[hue]?.[step];
    if (!cell) {
        throw new Error(
            `node-color: no ${hue} step ${step} defined (kind=${kind}, surface=${surface})`,
        );
    }
    return cell[surface];
}
