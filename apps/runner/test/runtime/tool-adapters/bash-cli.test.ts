import { describe, expect, it } from 'vitest';
import type { BashExecResult } from '../../../src/runtime/bash-exec.js';
import { runBashCliAdapter } from '../../../src/runtime/tool-adapters/bash-cli.js';
import type { RuntimeTool } from '../../../src/runtime/runtime-tools.js';

function makeTool(overrides: Partial<RuntimeTool['manifest']> = {}): RuntimeTool {
    const manifest: RuntimeTool['manifest'] = {
        name: 'linear_query',
        description: 'desc',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                limit: { type: 'number' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        adapter: 'bash_cli',
        adapter_config: {
            binary: 'bin/linear_query',
            arg_style: 'flags',
            arg_mapping: { query: '--query', limit: '--limit' },
        },
        ...overrides,
    };
    return {
        manifest,
        dir: '/fake/tools/linear_query',
        manifest_path: '/fake/tools/linear_query/manifest.json',
    };
}

const ctx = { call_id: 'c1', eventId: 'ev-1' };

describe('runBashCliAdapter', () => {
    it('resolves a relative binary against the tool dir and renders argv from arg_mapping', async () => {
        let captured: {
            binary: string;
            argv: string[];
            cwd: string;
            timeoutMs: number;
        } | null = null;
        const exec = async (opts: {
            binary: string;
            argv: string[];
            cwd: string;
            timeoutMs: number;
        }): Promise<BashExecResult> => {
            captured = opts;
            return { output: 'ok\n', exitCode: 0, timedOut: false };
        };
        const tool = makeTool();
        const r = await runBashCliAdapter(tool, { query: 'fixme', limit: 5 }, ctx, { exec });
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('ok\n');
        expect(captured).not.toBeNull();
        expect(captured!.binary).toBe('/fake/tools/linear_query/bin/linear_query');
        expect(captured!.cwd).toBe('/fake/tools/linear_query');
        expect(captured!.argv).toEqual(['--query', 'fixme', '--limit', '5']);
        expect(captured!.timeoutMs).toBe(30_000);
    });

    it('forwards ctx.signal to the executor and surfaces an aborted result cleanly', async () => {
        const controller = new AbortController();
        let signalSeen: AbortSignal | undefined;
        const exec = async (opts: {
            binary: string;
            argv: string[];
            cwd: string;
            timeoutMs: number;
            signal?: AbortSignal;
        }): Promise<BashExecResult> => {
            signalSeen = opts.signal;
            return { output: 'partial', exitCode: null, timedOut: false, aborted: true };
        };
        const r = await runBashCliAdapter(
            makeTool(),
            { query: 'x' },
            { call_id: 'c1', eventId: 'ev-1', signal: controller.signal },
            { exec },
        );
        expect(signalSeen).toBe(controller.signal);
        expect(r.exit_code).toBe(1);
        expect(r.stdout).toContain('cancelled by user');
    });

    it('honors an absolute binary path as-is', async () => {
        let binarySeen = '';
        const exec = async (opts: {
            binary: string;
            argv: string[];
            cwd: string;
            timeoutMs: number;
        }): Promise<BashExecResult> => {
            binarySeen = opts.binary;
            return { output: '', exitCode: 0, timedOut: false };
        };
        const tool = makeTool({
            adapter_config: {
                binary: '/usr/local/bin/linear-cli',
                arg_style: 'flags',
                arg_mapping: { query: '--query' },
            },
        });
        await runBashCliAdapter(tool, { query: 'x' }, ctx, { exec });
        expect(binarySeen).toBe('/usr/local/bin/linear-cli');
    });

    it('refuses with exit 1 when a required argument is missing', async () => {
        let execCalled = false;
        const exec = async (): Promise<BashExecResult> => {
            execCalled = true;
            return { output: '', exitCode: 0, timedOut: false };
        };
        const r = await runBashCliAdapter(makeTool(), {}, ctx, { exec });
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toBe('missing required argument: query');
        expect(execCalled).toBe(false);
    });

    it('refuses with exit 1 when a required argument has the wrong primitive type', async () => {
        let execCalled = false;
        const exec = async (): Promise<BashExecResult> => {
            execCalled = true;
            return { output: '', exitCode: 0, timedOut: false };
        };
        const r = await runBashCliAdapter(
            makeTool(),
            { query: 12345 } as unknown as Record<string, unknown>,
            ctx,
            { exec },
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/query must be a string/);
        expect(execCalled).toBe(false);
    });

    it('skips optional args the model did not supply', async () => {
        let argv: string[] = [];
        const exec = async (opts: { argv: string[] }): Promise<BashExecResult> => {
            argv = opts.argv;
            return { output: '', exitCode: 0, timedOut: false };
        };
        await runBashCliAdapter(makeTool(), { query: 'q' }, ctx, { exec: exec as never });
        expect(argv).toEqual(['--query', 'q']);
    });

    it('renders boolean true as a bare flag and omits false', async () => {
        let argv: string[] = [];
        const exec = async (opts: { argv: string[] }): Promise<BashExecResult> => {
            argv = opts.argv;
            return { output: '', exitCode: 0, timedOut: false };
        };
        const tool = makeTool({
            parameters: {
                type: 'object',
                properties: {
                    verbose: { type: 'boolean' },
                    quiet: { type: 'boolean' },
                },
                required: [],
                additionalProperties: false,
            },
            adapter_config: {
                binary: 'bin/x',
                arg_style: 'flags',
                arg_mapping: { verbose: '--verbose', quiet: '--quiet' },
            },
        });
        await runBashCliAdapter(tool, { verbose: true, quiet: false }, ctx, {
            exec: exec as never,
        });
        expect(argv).toEqual(['--verbose']);
    });

    it('clamps the manifest timeout to the 300_000ms ceiling', async () => {
        let timeoutMs = 0;
        const exec = async (opts: { timeoutMs: number }): Promise<BashExecResult> => {
            timeoutMs = opts.timeoutMs;
            return { output: '', exitCode: 0, timedOut: false };
        };
        const tool = makeTool({
            adapter_config: {
                binary: 'bin/x',
                arg_style: 'flags',
                arg_mapping: { query: '--query' },
                timeout_ms: 999_999_999,
            },
        });
        await runBashCliAdapter(tool, { query: 'q' }, ctx, { exec: exec as never });
        expect(timeoutMs).toBe(300_000);
    });

    it('maps a timeout result to exit_code 124 with a [<tool> timed out…] note', async () => {
        const exec = async (): Promise<BashExecResult> => ({
            output: 'partial\n',
            exitCode: null,
            timedOut: true,
        });
        const tool = makeTool({
            adapter_config: {
                binary: 'bin/x',
                arg_style: 'flags',
                arg_mapping: { query: '--query' },
                timeout_ms: 1000,
            },
        });
        const r = await runBashCliAdapter(tool, { query: 'q' }, ctx, { exec });
        expect(r.exit_code).toBe(124);
        expect(r.stdout).toMatch(/partial/);
        expect(r.stdout).toMatch(/\[linear_query timed out after 1000ms\]/);
    });

    it('truncates large output to the tail and appends the standard note', async () => {
        const big = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join('\n');
        const exec = async (): Promise<BashExecResult> => ({
            output: big,
            exitCode: 0,
            timedOut: false,
        });
        const r = await runBashCliAdapter(makeTool(), { query: 'q' }, ctx, { exec });
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/Output truncated: showing last 500 of 800 lines/);
        expect(r.stdout).toMatch(/line 800/);
        expect(r.stdout).not.toMatch(/^line 1$/m);
    });

    it('wraps a thrown exec error as a tool-shaped failure', async () => {
        const exec = async (): Promise<BashExecResult> => {
            throw new Error('spawn boom');
        };
        const r = await runBashCliAdapter(makeTool(), { query: 'q' }, ctx, { exec });
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/linear_query failed: spawn boom/);
    });

    it('forwards the secret env verbatim to exec and keeps it out of argv', async () => {
        let captured: {
            argv: string[];
            env?: Record<string, string>;
        } | null = null;
        const exec = async (opts: {
            binary: string;
            argv: string[];
            cwd: string;
            timeoutMs: number;
            env?: Record<string, string>;
        }): Promise<BashExecResult> => {
            captured = { argv: opts.argv, env: opts.env };
            return { output: '', exitCode: 0, timedOut: false };
        };
        const env = { STRIPE_SECRET_KEY: 'sk-test-123', LINEAR_TOKEN: 'lin_abc' };
        await runBashCliAdapter(makeTool(), { query: 'fixme', limit: 5 }, ctx, { exec, env });
        expect(captured).not.toBeNull();
        expect(captured!.env).toEqual(env);
        expect(captured!.argv).toEqual(['--query', 'fixme', '--limit', '5']);
        for (const value of Object.values(env)) {
            expect(captured!.argv).not.toContain(value);
        }
    });

    it('reproduces today call shape when env is absent (no env key passed to exec)', async () => {
        let hadEnvKey = false;
        let envValue: unknown;
        const exec = async (opts: {
            binary: string;
            argv: string[];
            cwd: string;
            timeoutMs: number;
            env?: Record<string, string>;
        }): Promise<BashExecResult> => {
            hadEnvKey = 'env' in opts;
            envValue = opts.env;
            return { output: '', exitCode: 0, timedOut: false };
        };
        await runBashCliAdapter(makeTool(), { query: 'q' }, ctx, { exec });
        expect(hadEnvKey).toBe(false);
        expect(envValue).toBeUndefined();
    });

    it('omits the env key for an empty env dict (no spurious env channel)', async () => {
        let hadEnvKey = false;
        const exec = async (opts: {
            binary: string;
            argv: string[];
            cwd: string;
            timeoutMs: number;
            env?: Record<string, string>;
        }): Promise<BashExecResult> => {
            hadEnvKey = 'env' in opts;
            return { output: '', exitCode: 0, timedOut: false };
        };
        await runBashCliAdapter(makeTool(), { query: 'q' }, ctx, { exec, env: {} });
        expect(hadEnvKey).toBe(false);
    });
});
