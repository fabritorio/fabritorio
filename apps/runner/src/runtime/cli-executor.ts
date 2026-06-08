import { spawn } from 'node:child_process';

export interface CliExecRequest {
    command: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    input?: string;
    timeoutMs?: number;
}

export interface CliExecResult {
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
}

export type CliExecutor = (req: CliExecRequest) => Promise<CliExecResult>;

export const defaultCliExecutor: CliExecutor = (req) =>
    new Promise<CliExecResult>((resolve, reject) => {
        const child = spawn(req.command, req.argv, {
            ...(req.cwd ? { cwd: req.cwd } : {}),
            env: req.env ? { ...process.env, ...req.env } : process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                exit_code: code ?? (signal ? 1 : 0),
                timed_out: timedOut,
            });
        });

        if (req.timeoutMs && req.timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, req.timeoutMs);
        }

        if (req.input) {
            child.stdin.write(req.input);
        }
        child.stdin.end();
    });
