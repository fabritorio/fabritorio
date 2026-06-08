import { describe, it, expect } from 'vitest';
import { defaultCliExecutor } from '../../src/runtime/cli-executor.js';

describe('defaultCliExecutor', () => {
    it('captures stdout/stderr and exit code from a real subprocess', async () => {
        const result = await defaultCliExecutor({
            command: process.execPath,
            argv: [
                '-e',
                'process.stdout.write("out:" + process.argv[1]); process.stderr.write("err"); process.exit(0)',
                'hello',
            ],
        });
        expect(result.stdout).toBe('out:hello');
        expect(result.stderr).toBe('err');
        expect(result.exit_code).toBe(0);
        expect(result.timed_out).toBe(false);
    });

    it('surfaces non-zero exit codes without throwing', async () => {
        const result = await defaultCliExecutor({
            command: process.execPath,
            argv: ['-e', 'process.stderr.write("boom"); process.exit(2)'],
        });
        expect(result.exit_code).toBe(2);
        expect(result.stderr).toBe('boom');
    });

    it('kills the child after timeoutMs and reports timed_out=true', async () => {
        const start = Date.now();
        const result = await defaultCliExecutor({
            command: process.execPath,
            argv: ['-e', 'setTimeout(() => {}, 5000)'],
            timeoutMs: 100,
        });
        const elapsed = Date.now() - start;
        expect(result.timed_out).toBe(true);
        expect(elapsed).toBeLessThan(2000);
    });

    it('rejects when the command does not exist', async () => {
        await expect(
            defaultCliExecutor({
                command: '/this/binary/does/not/exist-12345',
                argv: [],
            }),
        ).rejects.toThrow();
    });

    it('respects the cwd option', async () => {
        const result = await defaultCliExecutor({
            command: process.execPath,
            argv: ['-e', 'process.stdout.write(process.cwd())'],
            cwd: '/',
        });
        expect(result.stdout).toBe('/');
    });
});
