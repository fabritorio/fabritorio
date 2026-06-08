import type { Edge, Graph, Node } from '@fabritorio/types';

export const HANDLER_MAX_ITERATIONS_DEFAULT = 8;

export const MODEL_TEMPERATURE_DEFAULT = 0.3;

export const MODEL_PROVIDER_DEFAULT = 'ollama';

export const MODEL_ID_DEFAULT = 'gemma4:31b';

export const MODEL_AUTH_ENV_DEFAULT = 'OPENAI_API_KEY';

export const MODEL_SYSTEM_PROMPT_DEFAULT = 'You are a helpful assistant.';

export const MEMORY_LAST_N_DEFAULT = 20;

export const MEMORY_TOKEN_BUDGET_DEFAULT = 8192;

export const DEBUG_GATEWAY_MODE_DEFAULT = 'live' as const;

export const DEBUG_PROBE_HALT_ON_DEFAULT = 'both' as const;

export const DEBUG_PROBE_ENABLED_DEFAULT = true;

export const PERMISSION_STRATEGY_DEFAULT = 'call_user' as const;

export function applyNodeDefaults(node: Node): Node {
    switch (node.type) {
        case 'handler': {
            if (node.max_iterations !== undefined) return node;
            return { ...node, max_iterations: HANDLER_MAX_ITERATIONS_DEFAULT };
        }
        case 'model': {
            const patch: Partial<typeof node> = {};
            if (node.temperature === undefined) patch.temperature = MODEL_TEMPERATURE_DEFAULT;
            if (!node.provider) patch.provider = MODEL_PROVIDER_DEFAULT;
            if (!node.model_id) patch.model_id = MODEL_ID_DEFAULT;
            if (!node.auth_env) patch.auth_env = MODEL_AUTH_ENV_DEFAULT;
            if (node.system_prompt === undefined) {
                patch.system_prompt = MODEL_SYSTEM_PROMPT_DEFAULT;
            }
            if (Object.keys(patch).length === 0) return node;
            return { ...node, ...patch };
        }
        case 'memory': {
            if (node.handling === 'last_n' && node.n === undefined) {
                return { ...node, n: MEMORY_LAST_N_DEFAULT };
            }
            if (node.handling === 'last_within_tokens' && node.token_budget === undefined) {
                return { ...node, token_budget: MEMORY_TOKEN_BUDGET_DEFAULT };
            }
            return node;
        }
        case 'debug_gateway': {
            if (node.mode !== undefined) return node;
            return { ...node, mode: DEBUG_GATEWAY_MODE_DEFAULT };
        }
        case 'debug_probe': {
            const patch: Partial<typeof node> = {};
            if (node.haltOn === undefined) patch.haltOn = DEBUG_PROBE_HALT_ON_DEFAULT;
            if (node.enabled === undefined) patch.enabled = DEBUG_PROBE_ENABLED_DEFAULT;
            if (Object.keys(patch).length === 0) return node;
            return { ...node, ...patch };
        }
        case 'permission': {
            if (node.strategy !== undefined) return node;
            return { ...node, strategy: PERMISSION_STRATEGY_DEFAULT };
        }
        case 'secrets': {
            if (Array.isArray(node.bindings)) return node;
            return { ...node, bindings: [] };
        }
        default:
            return node;
    }
}

export function applyGraphDefaults(incoming: Pick<Graph, 'nodes' | 'edges'>): {
    nodes: Node[];
    edges: Edge[];
} {
    return {
        nodes: incoming.nodes.map(applyNodeDefaults),
        edges: incoming.edges.slice(),
    };
}
