import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBinary, truncateTail } from '../../src/runtime/bash-exec.js';

describe('executeBinary', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-execbin-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('runs a binary directly with the given argv', async () => {
        const bin = join(dir, 'echoer');
        writeFileSync(bin, '#!/usr/bin/env bash\necho "$1 $2"\n', 'utf8');
        chmodSync(bin, 0o755);
        const r = await executeBinary({
            binary: bin,
            argv: ['hello', 'world'],
            cwd: dir,
        });
        expect(r.exitCode).toBe(0);
        expect(r.output.trim()).toBe('hello world');
        expect(r.timedOut).toBe(false);
    });

    it('treats argv tokens as literal — no shell interpolation', async () => {
        const bin = join(dir, 'literal');
        writeFileSync(bin, '#!/usr/bin/env bash\necho "$1"\n', 'utf8');
        chmodSync(bin, 0o755);
        const r = await executeBinary({
            binary: bin,
            argv: ['$(whoami)'],
            cwd: dir,
        });
        expect(r.exitCode).toBe(0);
        expect(r.output.trim()).toBe('$(whoami)');
    });

    it('times out and reports timedOut + null exit code', async () => {
        const bin = join(dir, 'sleeper');
        writeFileSync(bin, '#!/usr/bin/env bash\nsleep 5\n', 'utf8');
        chmodSync(bin, 0o755);
        const r = await executeBinary({
            binary: bin,
            argv: [],
            cwd: dir,
            timeoutMs: 150,
        });
        expect(r.timedOut).toBe(true);
        expect(r.exitCode).toBeNull();
    }, 10_000);

    it('sanitizes ANSI escape sequences out of the merged output', async () => {
        const bin = join(dir, 'colored');
        writeFileSync(bin, "#!/usr/bin/env bash\nprintf '\\033[31mred\\033[0m\\n'\n", 'utf8');
        chmodSync(bin, 0o755);
        const r = await executeBinary({
            binary: bin,
            argv: [],
            cwd: dir,
        });
        expect(r.output.trim()).toBe('red');
    });

    it('merges env onto process.env — injected vars and inherited vars coexist', async () => {
        const bin = join(dir, 'envcheck');
        writeFileSync(
            bin,
            '#!/usr/bin/env bash\necho "SECRET=$SECRET_X PATH_SET=${PATH:+yes}"\n',
            'utf8',
        );
        chmodSync(bin, 0o755);
        const r = await executeBinary({
            binary: bin,
            argv: [],
            cwd: dir,
            env: { SECRET_X: 'sk-123' },
        });
        expect(r.exitCode).toBe(0);
        expect(r.output.trim()).toBe('SECRET=sk-123 PATH_SET=yes');
    });

    it('rejects when cwd does not exist', async () => {
        await expect(
            executeBinary({
                binary: '/bin/true',
                argv: [],
                cwd: join(dir, 'does-not-exist'),
            }),
        ).rejects.toThrow(/working directory does not exist/);
    });

    it('aborts a running process when the signal fires — sets the aborted marker', async () => {
        const bin = join(dir, 'sleeper');
        writeFileSync(bin, '#!/usr/bin/env bash\nsleep 5\n', 'utf8');
        chmodSync(bin, 0o755);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const r = await executeBinary({
            binary: bin,
            argv: [],
            cwd: dir,
            timeoutMs: 10_000,
            signal: controller.signal,
        });
        expect(r.aborted).toBe(true);
        expect(r.timedOut).toBe(false);
        expect(r.exitCode).toBeNull();
    }, 10_000);

    it('returns immediately (killed) when handed an already-aborted signal — no hang', async () => {
        const bin = join(dir, 'sleeper2');
        writeFileSync(bin, '#!/usr/bin/env bash\nsleep 30\n', 'utf8');
        chmodSync(bin, 0o755);
        const controller = new AbortController();
        controller.abort();
        const started = Date.now();
        const r = await executeBinary({
            binary: bin,
            argv: [],
            cwd: dir,
            timeoutMs: 60_000,
            signal: controller.signal,
        });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(r.aborted).toBe(true);
        expect(r.exitCode).toBeNull();
    }, 10_000);
});

describe('truncateTail', () => {
    it('returns input unchanged when under both limits', () => {
        const { content, note } = truncateTail('a\nb\nc', 100, 1024);
        expect(content).toBe('a\nb\nc');
        expect(note).toBeNull();
    });

    it('truncates to the tail by line count and appends a note', () => {
        const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
        const { content, note } = truncateTail(text, 3, 1024);
        expect(content.split('\n')).toEqual(['line7', 'line8', 'line9']);
        expect(note).toMatch(/showing last 3 of 10 lines/);
    });

    it('respects the byte budget when individual lines are large', () => {
        const big = 'x'.repeat(100);
        const text = [big, big, big].join('\n');
        const { content, note } = truncateTail(text, 100, 150);
        expect(content).toBe(big);
        expect(note).toMatch(/showing last 1 of 3 lines/);
    });
});
