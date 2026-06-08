import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface BashExecOptions {
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shellPath?: string;
    signal?: AbortSignal;
}

export interface BashExecResult {
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    aborted?: boolean;
}

const ANSI_RE = /\[[0-9;?]*[a-zA-Z]/g;

export function sanitizeShellOutput(input: string): string {
    const noAnsi = input.replace(ANSI_RE, '');
    let out = '';
    for (const ch of noAnsi) {
        const code = ch.codePointAt(0);
        if (code === undefined) continue;
        if (code === 0x09 || code === 0x0a || code === 0x0d) {
            out += ch;
            continue;
        }
        if (code <= 0x1f) continue;
        if (code >= 0xfff9 && code <= 0xfffb) continue;
        out += ch;
    }
    return out;
}

function resolveShell(shellPath?: string): string {
    if (shellPath) return shellPath;
    if (existsSync('/bin/bash')) return '/bin/bash';
    return '/bin/sh';
}

export function executeBash(opts: BashExecOptions): Promise<BashExecResult> {
    const shell = resolveShell(opts.shellPath);
    return spawnAndCollect({
        cmd: shell,
        argv: ['-c', opts.command],
        cwd: opts.cwd,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    });
}

export interface BinaryExecOptions {
    binary: string;
    argv: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export function executeBinary(opts: BinaryExecOptions): Promise<BashExecResult> {
    return spawnAndCollect({
        cmd: opts.binary,
        argv: opts.argv,
        cwd: opts.cwd,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    });
}

interface SpawnAndCollectOpts {
    cmd: string;
    argv: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
}

function spawnAndCollect(opts: SpawnAndCollectOpts): Promise<BashExecResult> {
    return new Promise((resolve, reject) => {
        if (!existsSync(opts.cwd)) {
            reject(new Error(`working directory does not exist: ${opts.cwd}`));
            return;
        }
        if (opts.signal?.aborted) {
            resolve({ output: '', exitCode: null, timedOut: false, aborted: true });
            return;
        }
        const child = spawn(opts.cmd, opts.argv, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const chunks: Buffer[] = [];
        let timedOut = false;
        let aborted = false;
        let timer: NodeJS.Timeout | undefined;

        const killTree = () => {
            if (child.pid === undefined) return;
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                try {
                    process.kill(child.pid, 'SIGKILL');
                } catch {
                    // already gone
                }
            }
        };

        if (opts.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                killTree();
            }, opts.timeoutMs);
        }

        const onAbort = () => {
            aborted = true;
            killTree();
        };
        opts.signal?.addEventListener('abort', onAbort);
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
        };

        child.stdout?.on('data', (d: Buffer) => chunks.push(d));
        child.stderr?.on('data', (d: Buffer) => chunks.push(d));

        child.on('error', (err) => {
            cleanup();
            reject(err);
        });
        child.on('close', (code) => {
            cleanup();
            const merged = sanitizeShellOutput(Buffer.concat(chunks).toString('utf8'));
            resolve({ output: merged, exitCode: code, timedOut, aborted });
        });
    });
}

export function truncateTail(
    text: string,
    maxLines: number,
    maxBytes: number,
): { content: string; note: string | null } {
    const totalBytes = Buffer.byteLength(text, 'utf8');
    const lines = text.split('\n');
    if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, note: null };
    }
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
        const line = lines[i] ?? '';
        const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
        if (bytes + lineBytes > maxBytes) break;
        kept.unshift(line);
        bytes += lineBytes;
    }
    const content = kept.join('\n');
    const note = `[Output truncated: showing last ${kept.length} of ${lines.length} lines]`;
    return { content, note };
}
