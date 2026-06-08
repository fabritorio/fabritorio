import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Phase 2 security hooks (`docs/install-and-security.md` §5). Two controls live
 * here:
 *
 *  1. **Host-header allowlist** (closes DNS rebinding). Registered on the root
 *     app so it covers BOTH the `/api` scope and the static SPA serving. A page
 *     on `evil.com` that rebinds its DNS to `127.0.0.1` reaches the runner with
 *     `Host: evil.com`; the browser treats it as same-origin and runs no CORS
 *     check, so CORS can't stop it. Rejecting any non-loopback Host host-part
 *     does. `FAB_ALLOWED_HOSTS` adds extra hostnames for the LAN case (§5.3).
 *
 *  2. **Per-install token** on mutating / side-effecting routes. Registered
 *     inside the `/api` scope. Header `X-Fabritorio-Token`, or `?token=` for the
 *     native-EventSource SSE streams that can't set a header (see below). The
 *     Host hook + loopback bind already gate *reach*; the token is the second
 *     lock against request forgery and the precondition for a safe non-loopback
 *     bind.
 */

/** Loopback host-parts (no port). `localhost` + the v4/v6 loopback literals. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Extract the host-part from a `Host` header value, stripping any `:port`.
 * Handles the IPv6 bracket form (`[::1]`, `[::1]:4000`) — the brackets are
 * removed so the result compares against the bare `::1` literal. Returns the
 * lowercased host-part, or `null` if the header is empty.
 */
export function hostPartOf(hostHeader: string | undefined): string | null {
    if (hostHeader === undefined) return null;
    const raw = hostHeader.trim();
    if (raw.length === 0) return null;
    // IPv6 bracket form: `[::1]` or `[::1]:4000`.
    if (raw.startsWith('[')) {
        const close = raw.indexOf(']');
        if (close === -1) return null; // malformed
        return raw.slice(1, close).toLowerCase();
    }
    // IPv4 / hostname form: strip a trailing `:port` if present. A bare IPv6
    // without brackets can't carry a port, but it also can't legally appear in
    // a Host header, so splitting on the last colon is safe for the v4/name case.
    const colon = raw.lastIndexOf(':');
    if (colon !== -1) {
        // Only treat the suffix as a port if it's all digits — otherwise it's a
        // (malformed) unbracketed IPv6 we leave intact to fail the allowlist.
        const suffix = raw.slice(colon + 1);
        if (/^\d+$/.test(suffix)) return raw.slice(0, colon).toLowerCase();
    }
    return raw.toLowerCase();
}

/** Parse `FAB_ALLOWED_HOSTS` (comma-separated) into a lowercased set. */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
    const set = new Set<string>();
    if (!raw) return set;
    for (const part of raw.split(',')) {
        const h = part.trim().toLowerCase();
        if (h.length > 0) set.add(h);
    }
    return set;
}

/**
 * Register the Host-header allowlist as a root `onRequest` hook. Any request
 * whose Host host-part isn't loopback (or in `FAB_ALLOWED_HOSTS`) → 403. A
 * request with no Host header is rejected too (a DNS-rebind probe can omit it).
 */
export function registerHostAllowlist(app: FastifyInstance, extraHosts: Set<string>): void {
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        const host = hostPartOf(req.headers.host);
        if (host !== null && (LOOPBACK_HOSTS.has(host) || extraHosts.has(host))) {
            return; // allowed
        }
        await reply.code(403).send({ error: 'forbidden_host' });
    });
}

/**
 * SSE GET stream routes that trigger / expose runtime work and therefore require
 * the token even though they're GETs. These are opened by the SPA via native
 * `EventSource`, which cannot set request headers — so the token rides as a
 * `?token=` query param for these paths (the check below reads either source).
 *
 * Matched against the path AFTER the `/api` prefix is stripped (the hook runs
 * inside the `/api` scope, where `req.url` still carries `/api/...`), so we test
 * the suffix. All of these end in `/stream`; we gate on that suffix rather than
 * enumerate every parameterized path, which keeps new SSE routes covered by
 * default. Pure GET reads (graph fetch, palette, tools, skills, memory reads,
 * health, bootstrap) do NOT end in `/stream` and stay token-free — reach is
 * already gated by the Host hook + loopback bind.
 */
function isSideEffectingGet(pathname: string): boolean {
    return pathname.endsWith('/stream');
}

/**
 * Register the token check as an `onRequest` hook on the `/api` scope.
 *
 * Requires the token on:
 *   - every non-GET method (POST/PUT/PATCH/DELETE) — all mutating routes, AND
 *   - side-effecting GET SSE streams (paths ending in `/stream`).
 *
 * Exempt (reachable without a token — Host hook + loopback already gate reach):
 *   - `GET /api/health` and `GET /api/bootstrap` (the SPA needs bootstrap to
 *     learn the token in the first place), and
 *   - all other pure GET reads.
 *
 * Token source: `X-Fabritorio-Token` header, or `?token=` query param (the
 * latter is the only channel native `EventSource` can use for SSE GETs).
 */
export function registerTokenCheck(api: FastifyInstance, token: string): void {
    api.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        // `req.routeOptions.url` is the registered path (without query); fall
        // back to `req.url` split on `?`. Inside this scope it includes `/api`.
        const pathname = req.url.split('?')[0] ?? req.url;

        // Token-exempt endpoints: health + bootstrap. Compared against the
        // scoped path which carries the `/api` prefix.
        if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/api/bootstrap')) {
            return;
        }

        const mutating = req.method !== 'GET';
        const sideEffectingGet = req.method === 'GET' && isSideEffectingGet(pathname);
        if (!mutating && !sideEffectingGet) {
            return; // pure read — no token required
        }

        const header = req.headers['x-fabritorio-token'];
        const headerToken = Array.isArray(header) ? header[0] : header;
        const queryToken =
            typeof req.query === 'object' && req.query !== null
                ? (req.query as Record<string, unknown>).token
                : undefined;
        const provided = headerToken ?? (typeof queryToken === 'string' ? queryToken : undefined);

        if (provided !== token) {
            await reply.code(401).send({ error: 'unauthorized' });
        }
    });
}
