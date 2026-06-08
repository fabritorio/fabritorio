import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Per-install token (`docs/install-and-security.md` §5.2). On first boot we mint
 * a random 256-bit hex token into `~/.fabritorio/token` (mode `0600`) and load
 * the same value on every subsequent boot. The token is required on every
 * mutating / side-effecting route as `X-Fabritorio-Token` (or `?token=` for the
 * native-EventSource SSE streams, which can't set a header).
 *
 * Why a token at all when the Host-allowlist hook already gates reach: it is the
 * second lock against request forgery. A custom request header forces a CORS
 * preflight a cross-origin page can't satisfy, and it's the precondition that
 * makes the non-loopback bind (`dev:lan`) defensible (§5.3). On a normal
 * loopback boot it's automatic and invisible — the SPA fetches it from
 * `GET /api/bootstrap` (Host-gated, token-exempt) and attaches it transparently.
 *
 * Mirrors `secrets-store.ts` for the home-dir resolution: `homedir()` +
 * `.fabritorio`, with a `dir` override so tests can point at a tmp dir.
 */

function defaultDir(): string {
    return join(homedir(), '.fabritorio');
}

/**
 * Mint-or-load the per-install token from `<dir>/token`.
 *
 * - If the file is absent: create `<dir>` if needed, mint
 *   `randomBytes(32).toString('hex')` and write it with mode `0600`.
 * - If present: read and return it verbatim (trimmed). We also re-assert `0600`
 *   on the existing file so a token that predates this code (or had its perms
 *   loosened) is tightened on next boot.
 *
 * `dir` defaults to `~/.fabritorio`; tests pass a tmp dir for isolation.
 */
export function loadOrMintToken(dir: string = defaultDir()): string {
    const root = resolve(dir);
    const path = join(root, 'token');
    if (existsSync(path)) {
        // Re-assert perms on the existing file (best-effort — a chmod failure on
        // an exotic FS must not block boot; the file is still loopback-gated).
        try {
            chmodSync(path, 0o600);
        } catch {
            /* ignore */
        }
        return readFileSync(path, 'utf8').trim();
    }
    // `recursive: true` is a no-op when the dir already exists (same pattern the
    // memory / event-log dirs use). The token itself is created `0600`; the dir
    // keeps the default umask (matching the rest of `~/.fabritorio`).
    mkdirSync(dirname(path), { recursive: true });
    const token = randomBytes(32).toString('hex');
    writeFileSync(path, token, { mode: 0o600 });
    // writeFileSync's `mode` only applies on create and is subject to umask;
    // chmod to be certain the file is exactly 0600 regardless of umask.
    try {
        chmodSync(path, 0o600);
    } catch {
        /* ignore */
    }
    return token;
}
