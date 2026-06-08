import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { loadOrMintToken } from '../src/runtime/token.js';
import { hostPartOf, parseAllowedHosts } from '../src/runtime/security-hooks.js';
import { isLoopbackBind } from '../src/config.js';

const TEST_TOKEN = 'test-token-deadbeef';

describe('Host-header allowlist (§5.1)', () => {
    it('rejects a non-loopback Host with 403 (DNS rebinding)', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const res = await app.inject({
                method: 'GET',
                url: '/api/health',
                headers: { host: 'evil.com' },
            });
            expect(res.statusCode).toBe(403);
        } finally {
            await app.close();
        }
    });

    it('treats a missing/empty Host as not-loopback (would 403)', () => {
        expect(hostPartOf(undefined)).toBeNull();
        expect(hostPartOf('')).toBeNull();
    });

    it('allows loopback hosts on any port', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            for (const host of ['localhost', '127.0.0.1:4000', '[::1]:4000', 'localhost:3000']) {
                const res = await app.inject({
                    method: 'GET',
                    url: '/api/health',
                    headers: { host },
                });
                expect(res.statusCode, host).toBe(200);
            }
        } finally {
            await app.close();
        }
    });

    it('allows a FAB_ALLOWED_HOSTS entry', async () => {
        const prev = process.env.FAB_ALLOWED_HOSTS;
        process.env.FAB_ALLOWED_HOSTS = '192.168.1.50,my-lan-host';
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const res = await app.inject({
                method: 'GET',
                url: '/api/health',
                headers: { host: '192.168.1.50:4000' },
            });
            expect(res.statusCode).toBe(200);
        } finally {
            await app.close();
            if (prev === undefined) delete process.env.FAB_ALLOWED_HOSTS;
            else process.env.FAB_ALLOWED_HOSTS = prev;
        }
    });
});

describe('hostPartOf / parseAllowedHosts', () => {
    it('strips ports and brackets', () => {
        expect(hostPartOf('localhost')).toBe('localhost');
        expect(hostPartOf('127.0.0.1:4000')).toBe('127.0.0.1');
        expect(hostPartOf('[::1]')).toBe('::1');
        expect(hostPartOf('[::1]:4000')).toBe('::1');
        expect(hostPartOf('EVIL.COM:8080')).toBe('evil.com');
        expect(hostPartOf('')).toBeNull();
        expect(hostPartOf(undefined)).toBeNull();
    });
    it('parses comma lists', () => {
        expect(parseAllowedHosts('a, B ,c').has('b')).toBe(true);
        expect(parseAllowedHosts(undefined).size).toBe(0);
    });
});

describe('Per-install token (§5.2)', () => {
    it('401s a mutating POST route without the token', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/api/graphs',
                payload: { kind: 'l1', name: 'x', nodes: [], edges: [] },
            });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('allows the same POST with a correct token (header)', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/api/graphs',
                headers: { 'x-fabritorio-token': TEST_TOKEN },
                payload: { kind: 'l1', name: 'x', nodes: [], edges: [] },
            });
            expect(res.statusCode).not.toBe(401);
            expect([200, 201]).toContain(res.statusCode);
        } finally {
            await app.close();
        }
    });

    it('401s with a wrong token', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/api/graphs',
                headers: { 'x-fabritorio-token': 'nope' },
                payload: { kind: 'l1', name: 'x', nodes: [], edges: [] },
            });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('does not require a token on a pure GET read', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const res = await app.inject({ method: 'GET', url: '/api/graphs' });
            expect(res.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it('401s a side-effecting SSE stream GET without a token', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const denied = await app.inject({
                method: 'GET',
                url: '/api/stream',
            });
            expect(denied.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('accepts the `?token=` query fallback on a side-effecting SSE stream GET', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        const address = await app.listen({ port: 0, host: '127.0.0.1' });
        const controller = new AbortController();
        try {
            const res = await fetch(`${address}/api/stream?token=${TEST_TOKEN}`, {
                headers: { accept: 'text/event-stream' },
                signal: controller.signal,
            });
            expect(res.status).toBe(200);
            controller.abort();
        } finally {
            controller.abort();
            await app.close();
        }
    });

    it('serves the token at the token-exempt GET /api/bootstrap', async () => {
        const app = buildServer({ logger: false, token: TEST_TOKEN });
        try {
            const res = await app.inject({ method: 'GET', url: '/api/bootstrap' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { token: string; version: string };
            expect(body.token).toBe(TEST_TOKEN);
            expect(typeof body.version).toBe('string');
        } finally {
            await app.close();
        }
    });

    it('a loopback boot works with the minted token in place', async () => {
        const app = buildServer({ logger: false });
        try {
            const boot = await app.inject({ method: 'GET', url: '/api/bootstrap' });
            const { token } = boot.json() as { token: string };
            expect(typeof token).toBe('string');
            expect(token.length).toBeGreaterThan(0);
            const res = await app.inject({
                method: 'POST',
                url: '/api/graphs',
                headers: { 'x-fabritorio-token': token },
                payload: { kind: 'l1', name: 'x', nodes: [], edges: [] },
            });
            expect(res.statusCode).not.toBe(401);
        } finally {
            await app.close();
        }
    });
});

describe('loadOrMintToken (§5.2)', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-token-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('mints a 64-char hex token with mode 0600 and persists it', () => {
        const t1 = loadOrMintToken(dir);
        expect(t1).toMatch(/^[0-9a-f]{64}$/);
        const path = join(dir, 'token');
        expect(existsSync(path)).toBe(true);
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
        const t2 = loadOrMintToken(dir);
        expect(t2).toBe(t1);
    });

    it('re-asserts 0600 on an existing token with loose perms', () => {
        const path = join(dir, 'token');
        writeFileSync(path, 'preexisting', { mode: 0o644 });
        const t = loadOrMintToken(dir);
        expect(t).toBe('preexisting');
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });
});

describe('isLoopbackBind (§5.3)', () => {
    it('treats loopback literals as loopback and wildcards as not', () => {
        expect(isLoopbackBind('127.0.0.1')).toBe(true);
        expect(isLoopbackBind('::1')).toBe(true);
        expect(isLoopbackBind('localhost')).toBe(true);
        expect(isLoopbackBind('0.0.0.0')).toBe(false);
        expect(isLoopbackBind('::')).toBe(false);
        expect(isLoopbackBind('192.168.1.5')).toBe(false);
    });
});

describe('secrets.env perms (§5.4)', () => {
    it('tightens an existing secrets file to 0600 on scan', async () => {
        const sdir = mkdtempSync(join(tmpdir(), 'fabritorio-secrets-perm-'));
        const path = join(sdir, 'secrets.env');
        try {
            writeFileSync(path, 'FOO=bar\n', { mode: 0o644 });
            const { createSecretsStore } = await import('../src/runtime/secrets-store.js');
            const store = createSecretsStore({ path });
            expect(store.get('FOO')).toBe('bar');
            expect(statSync(path).mode & 0o777).toBe(0o600);
            expect(readFileSync(path, 'utf8')).toContain('FOO=bar');
        } finally {
            rmSync(sdir, { recursive: true, force: true });
        }
    });
});
