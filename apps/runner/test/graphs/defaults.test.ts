import { describe, it, expect } from 'vitest';
import type { Node } from '@fabritorio/types';
import {
    applyNodeDefaults,
    HANDLER_MAX_ITERATIONS_DEFAULT,
    MODEL_TEMPERATURE_DEFAULT,
    MODEL_PROVIDER_DEFAULT,
    MODEL_ID_DEFAULT,
    MODEL_AUTH_ENV_DEFAULT,
    MODEL_SYSTEM_PROMPT_DEFAULT,
    MEMORY_LAST_N_DEFAULT,
    MEMORY_TOKEN_BUDGET_DEFAULT,
    DEBUG_GATEWAY_MODE_DEFAULT,
    DEBUG_PROBE_HALT_ON_DEFAULT,
    DEBUG_PROBE_ENABLED_DEFAULT,
    PERMISSION_STRATEGY_DEFAULT,
} from '../../src/graphs/defaults.js';

const POS = { x: 0, y: 0 };

describe('applyNodeDefaults', () => {
    describe('handler', () => {
        it('fills max_iterations when absent', () => {
            const node: Node = { id: 'h', type: 'handler', position: POS };
            const out = applyNodeDefaults(node);
            expect(out).toEqual({
                id: 'h',
                type: 'handler',
                position: POS,
                max_iterations: HANDLER_MAX_ITERATIONS_DEFAULT,
            });
        });

        it('preserves a supplied max_iterations', () => {
            const node: Node = { id: 'h', type: 'handler', position: POS, max_iterations: 4 };
            const out = applyNodeDefaults(node);
            expect(out).toBe(node);
        });
    });

    describe('model', () => {
        it('fills temperature when absent', () => {
            const node: Node = {
                id: 'm',
                type: 'model',
                position: POS,
                provider: 'openai',
                model_id: 'gpt-4o-mini',
            };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({ temperature: MODEL_TEMPERATURE_DEFAULT });
        });

        it('preserves a supplied temperature (including 0)', () => {
            const node: Node = {
                id: 'm',
                type: 'model',
                position: POS,
                provider: 'openai',
                model_id: 'gpt-4o-mini',
                auth_env: 'OPENAI_API_KEY',
                system_prompt: 'Custom prompt.',
                temperature: 0,
            };
            const out = applyNodeDefaults(node);
            expect(out).toBe(node);
            expect((out as { temperature: number }).temperature).toBe(0);
        });

        it('stamps starter provider / model_id / auth_env / system_prompt when absent', () => {
            const node: Node = {
                id: 'm',
                type: 'model',
                position: POS,
                provider: '',
                model_id: '',
            };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({
                provider: MODEL_PROVIDER_DEFAULT,
                model_id: MODEL_ID_DEFAULT,
                auth_env: MODEL_AUTH_ENV_DEFAULT,
                system_prompt: MODEL_SYSTEM_PROMPT_DEFAULT,
            });
        });

        it('preserves explicit provider / model_id / auth_env / system_prompt', () => {
            const node: Node = {
                id: 'm',
                type: 'model',
                position: POS,
                provider: 'gemini',
                model_id: 'gemini-2.0-flash',
                auth_env: 'GEMINI_API_KEY',
                system_prompt: 'Custom prompt.',
            };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({
                provider: 'gemini',
                model_id: 'gemini-2.0-flash',
                auth_env: 'GEMINI_API_KEY',
                system_prompt: 'Custom prompt.',
            });
        });

        it('preserves an empty system_prompt (explicit blank, not absent)', () => {
            const node: Node = {
                id: 'm',
                type: 'model',
                position: POS,
                provider: 'openai',
                model_id: 'gpt-4o-mini',
                system_prompt: '',
            };
            const out = applyNodeDefaults(node) as { system_prompt: string };
            expect(out.system_prompt).toBe('');
        });
    });

    describe('memory', () => {
        it('fills n when handling is last_n and n absent', () => {
            const node: Node = {
                id: 'mem',
                type: 'memory',
                position: POS,
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'last_n',
                tool_access: 'none',
            };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({ n: MEMORY_LAST_N_DEFAULT });
        });

        it('fills token_budget when handling is last_within_tokens and absent', () => {
            const node: Node = {
                id: 'mem',
                type: 'memory',
                position: POS,
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'last_within_tokens',
                tool_access: 'none',
            };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({ token_budget: MEMORY_TOKEN_BUDGET_DEFAULT });
        });

        it('leaves n alone for non-last_n handling modes', () => {
            const node: Node = {
                id: 'mem',
                type: 'memory',
                position: POS,
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'full_history',
                tool_access: 'none',
            };
            const out = applyNodeDefaults(node);
            expect(out).toBe(node);
            expect((out as { n?: number }).n).toBeUndefined();
        });

        it('preserves a supplied n', () => {
            const node: Node = {
                id: 'mem',
                type: 'memory',
                position: POS,
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'last_n',
                tool_access: 'none',
                n: 5,
            };
            const out = applyNodeDefaults(node);
            expect(out).toBe(node);
        });
    });

    describe('debug_gateway', () => {
        it('fills mode when absent', () => {
            const node: Node = { id: 'dg', type: 'debug_gateway', position: POS };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({ mode: DEBUG_GATEWAY_MODE_DEFAULT });
        });

        it('preserves a supplied mode', () => {
            const node: Node = {
                id: 'dg',
                type: 'debug_gateway',
                position: POS,
                mode: 'scratch',
            };
            const out = applyNodeDefaults(node);
            expect(out).toBe(node);
        });
    });

    describe('debug_probe', () => {
        it('fills haltOn and enabled when both absent', () => {
            const node: Node = { id: 'p', type: 'debug_probe', position: POS };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({
                haltOn: DEBUG_PROBE_HALT_ON_DEFAULT,
                enabled: DEBUG_PROBE_ENABLED_DEFAULT,
            });
        });

        it('preserves enabled=false when explicitly set', () => {
            const node: Node = {
                id: 'p',
                type: 'debug_probe',
                position: POS,
                enabled: false,
            };
            const out = applyNodeDefaults(node) as { enabled: boolean; haltOn: string };
            expect(out.enabled).toBe(false);
            expect(out.haltOn).toBe(DEBUG_PROBE_HALT_ON_DEFAULT);
        });
    });

    describe('permission', () => {
        it('fills strategy when absent', () => {
            const node: Node = { id: 'perm', type: 'permission', position: POS };
            const out = applyNodeDefaults(node);
            expect(out).toMatchObject({ strategy: PERMISSION_STRATEGY_DEFAULT });
        });
    });

    describe('no-default node kinds', () => {
        it('passes gateway through untouched', () => {
            const node: Node = { id: 'g', type: 'gateway', position: POS };
            expect(applyNodeDefaults(node)).toBe(node);
        });

        it('passes tool through untouched (no defaultable optional fields)', () => {
            const node: Node = {
                id: 't',
                type: 'tool',
                position: POS,
                tool_name: 'read_file',
            };
            expect(applyNodeDefaults(node)).toBe(node);
        });

        it('passes workspace through untouched', () => {
            const node: Node = {
                id: 'w',
                type: 'workspace',
                position: POS,
                path: '/tmp',
                permissions: 'read-write',
            };
            expect(applyNodeDefaults(node)).toBe(node);
        });
    });

    describe('idempotency', () => {
        it('applies once is the same as applies twice (handler)', () => {
            const node: Node = { id: 'h', type: 'handler', position: POS };
            const once = applyNodeDefaults(node);
            const twice = applyNodeDefaults(once);
            expect(twice).toEqual(once);
        });

        it('applies once is the same as applies twice (memory + last_n)', () => {
            const node: Node = {
                id: 'mem',
                type: 'memory',
                position: POS,
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'last_n',
                tool_access: 'none',
            };
            const once = applyNodeDefaults(node);
            const twice = applyNodeDefaults(once);
            expect(twice).toEqual(once);
        });
    });
});
