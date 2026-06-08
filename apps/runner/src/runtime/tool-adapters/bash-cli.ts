import { isAbsolute, join } from 'node:path';
import { executeBinary, truncateTail, type BashExecResult } from '../bash-exec.js';
import type { RuntimeTool } from '../runtime-tools.js';
import type { ToolHandlerContext, ToolResult } from '../tools.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_BYTES = 32 * 1024;

export interface BashCliExecutor {
    (opts: {
        binary: string;
        argv: string[];
        cwd: string;
        timeoutMs: number;
        env?: Record<string, string>;
        signal?: AbortSignal;
    }): Promise<BashExecResult>;
}

const defaultExec: BashCliExecutor = (opts) =>
    executeBinary({
        binary: opts.binary,
        argv: opts.argv,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    });

export interface BashCliAdapterOptions {
    exec?: BashCliExecutor;
    env?: Record<string, string>;
}

export async function runBashCliAdapter(
    tool: RuntimeTool,
    args: Record<string, unknown>,
    ctx: ToolHandlerContext,
    opts: BashCliAdapterOptions = {},
): Promise<ToolResult> {
    const { manifest, dir } = tool;
    const cfg = manifest.adapter_config;

    const validation = validateArgs(args, manifest.parameters);
    if (!validation.ok) {
        return { stdout: '', stderr: validation.reason, exit_code: 1 };
    }

    const renderedArgv = renderArgv(args, cfg.arg_mapping);
    const binary = isAbsolute(cfg.binary) ? cfg.binary : join(dir, cfg.binary);
    const timeoutMs = Math.min(cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const exec = opts.exec ?? defaultExec;

    let result: BashExecResult;
    try {
        result = await exec({
            binary,
            argv: renderedArgv,
            cwd: dir,
            timeoutMs,
            ...(opts.env && Object.keys(opts.env).length > 0 ? { env: opts.env } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { stdout: '', stderr: `${manifest.name} failed: ${msg}`, exit_code: 1 };
    }

    const truncation = truncateTail(result.output, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
    let stdout = truncation.content;
    if (truncation.note) {
        stdout = stdout ? `${stdout}\n\n${truncation.note}` : truncation.note;
    }
    if (result.aborted) {
        const note = `[${manifest.name} cancelled by user]`;
        stdout = stdout ? `${stdout}\n\n${note}` : note;
        return { stdout, stderr: '', exit_code: 1 };
    }
    if (result.timedOut) {
        const note = `[${manifest.name} timed out after ${timeoutMs}ms]`;
        stdout = stdout ? `${stdout}\n\n${note}` : note;
        return { stdout, stderr: '', exit_code: 124 };
    }
    return { stdout, stderr: '', exit_code: result.exitCode ?? 1 };
}

interface ParameterSchema {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
}

function validateArgs(
    args: Record<string, unknown>,
    parameters: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
    const schema = parameters as ParameterSchema;
    const requiredRaw = schema.required;
    const required = Array.isArray(requiredRaw)
        ? requiredRaw.filter((v): v is string => typeof v === 'string')
        : [];
    const props =
        schema.properties &&
        typeof schema.properties === 'object' &&
        !Array.isArray(schema.properties)
            ? (schema.properties as Record<string, unknown>)
            : {};
    for (const key of required) {
        if (!(key in args) || args[key] === undefined || args[key] === null) {
            return { ok: false, reason: `missing required argument: ${key}` };
        }
        const prop = props[key];
        if (!prop || typeof prop !== 'object') continue;
        const expected = (prop as { type?: unknown }).type;
        if (typeof expected !== 'string') continue;
        const actual = typeof args[key];
        if (expected === 'number' && actual !== 'number') {
            return { ok: false, reason: `argument ${key} must be a number (got ${actual})` };
        }
        if (expected === 'string' && actual !== 'string') {
            return { ok: false, reason: `argument ${key} must be a string (got ${actual})` };
        }
        if (expected === 'boolean' && actual !== 'boolean') {
            return { ok: false, reason: `argument ${key} must be a boolean (got ${actual})` };
        }
    }
    return { ok: true };
}

function renderArgv(args: Record<string, unknown>, mapping: Record<string, string>): string[] {
    const out: string[] = [];
    for (const [key, flag] of Object.entries(mapping)) {
        if (!(key in args)) continue;
        const value = args[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'boolean') {
            if (value) out.push(flag);
            continue;
        }
        out.push(flag, String(value));
    }
    return out;
}
