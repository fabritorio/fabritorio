import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { truncateTail } from './bash-exec.js';
import type { Tool, ToolResult, ToolSpec } from './tools.js';

/**
 * Built-in `web_fetch` tool: pull a URL over HTTP(S) and return its body in a
 * usable shape (markdown / raw / json / soup). Always-on baseline — "make
 * agents online" is table-stakes, which is what the compiled-in builtin set is
 * for (see `docs/fetch-tool-node.md`). Userland/extensible network tools belong
 * on the runtime-tool surface; this is the guaranteed floor.
 *
 * This is also the first consumer of the tool-node config primitive: the node
 * inspector can *pin* `mode` (and `selector`), in which case `createWebFetchTool`
 * prunes that param from the model-facing schema so the model can't deviate.
 * Same mechanism, two binding times (model-per-call vs design-time pin).
 */

const WEB_FETCH_MODES = ['markdown', 'raw', 'json', 'soup'] as const;
type FetchMode = (typeof WEB_FETCH_MODES)[number];

// Match the bash tool's caps so every command-style/output-heavy tool shapes
// output identically (see `bash-exec.ts` / `builtin-tools.ts`).
const WEB_FETCH_DEFAULT_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * Undici sends no `User-Agent` and none of the `Accept*` / `Sec-Fetch-*` headers
 * a real browser always carries, so a naive fetch trips the cheapest tier of
 * bot-blocking (header sniffing) and 403s on a lot of sites. Presenting a
 * desktop-browser header set clears that tier. It does NOT change our TLS/JA3
 * fingerprint — JS challenges and fingerprint blocks still belong on heavier,
 * userland network tools, not this pure-node floor.
 */
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function browserHeaders(userAgent: string): Record<string, string> {
    return {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
    };
}

/** Optional injection seams so unit tests stub the network + DNS. */
export interface WebFetchToolDeps {
    /** Defaults to Node's global `fetch`. */
    fetchFn?: typeof fetch;
    /**
     * Resolve a hostname to its addresses for the SSRF guard. Defaults to
     * `dns.lookup(host, { all: true })`. Tests stub this to avoid real DNS.
     */
    lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

function isValidMode(value: unknown): value is FetchMode {
    return typeof value === 'string' && (WEB_FETCH_MODES as readonly string[]).includes(value);
}

function baseParameters(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'Absolute http(s) URL to fetch.',
            },
            mode: {
                type: 'string',
                enum: [...WEB_FETCH_MODES],
                description:
                    'How to process the body. markdown (readable main content as Markdown — default), raw (verbatim body text), json (parsed + pretty-printed; errors if not JSON), soup (extract elements matching `selector`).',
            },
            selector: {
                type: 'string',
                description: 'CSS selector; required when mode = soup.',
            },
        },
        required: ['url'] as string[],
        additionalProperties: false,
    };
}

export const WEB_FETCH_SPEC: ToolSpec = {
    name: 'web_fetch',
    description:
        'Fetch a URL over HTTP(S) and return its body. `mode` selects how the body is ' +
        'processed: markdown (readable main content as Markdown — default, best for reading pages), ' +
        'raw (verbatim body text), json (parsed + pretty-printed; errors if not JSON), soup ' +
        '(extract elements matching a CSS `selector`). Returns up to ~32KB / 500 lines.',
    parameters: baseParameters(),
    config_schema: [
        {
            name: 'mode',
            kind: 'enum',
            label: 'Mode',
            options: [...WEB_FETCH_MODES],
            description: 'Pin the output mode. Leave unset to let the model choose per call.',
        },
        {
            name: 'selector',
            kind: 'string',
            label: 'CSS selector',
            placeholder: 'e.g. article h2',
            description: 'Pin the soup selector.',
            showWhen: { field: 'mode', equals: 'soup' },
        },
        {
            name: 'user_agent',
            kind: 'string',
            label: 'User-Agent',
            placeholder: DEFAULT_USER_AGENT,
            description:
                'Override the User-Agent header sent with each request. Leave unset for a default desktop-browser UA.',
        },
    ],
};

/**
 * Reject loopback / private / link-local addresses — the SSRF floor. Blocks the
 * cloud-metadata pivot (`169.254.169.254`) and intranet scans. Covers IPv4
 * `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0.0.0.0`; IPv6
 * `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped equivalents (`::ffff:a.b.c.d`).
 */
export function isBlockedAddress(addr: string): boolean {
    const ip = addr.trim().toLowerCase();
    const v = isIP(ip);
    if (v === 4) return isBlockedIPv4(ip);
    if (v === 6) {
        // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible — unwrap and
        // re-check against the v4 rules so a mapped metadata IP can't slip past.
        const mapped = ip.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped?.[1] && isIP(mapped[1]) === 4) return isBlockedIPv4(mapped[1]);
        if (ip === '::1' || ip === '::') return true;
        // fc00::/7 (unique-local) — first byte 0xfc or 0xfd.
        if (/^f[cd]/.test(ip)) return true;
        // fe80::/10 (link-local) — fe8, fe9, fea, feb.
        if (/^fe[89ab]/.test(ip)) return true;
        return false;
    }
    // Not a parseable IP (shouldn't happen — caller passes resolved addresses).
    return false;
}

function isBlockedIPv4(ip: string): boolean {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+ metadata)
    if (a === 0) return true; // 0.0.0.0/8 ("this host")
    return false;
}

function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
    return new Promise((resolve, reject) => {
        dnsLookup(hostname, { all: true }, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
        });
    });
}

/**
 * Resolve `hostname` and reject if ANY resolved address is blocked. Returns an
 * error string on rejection, or null when egress is allowed.
 *
 * Residual gap: this is a resolve-then-fetch TOCTOU window — a DNS rebind
 * between this lookup and the actual `fetch` could point at a blocked address
 * after the check passes. Acceptable for v0 (fetch is not yet driven by
 * untrusted multi-tenant input); revisit with a pinned-IP connect agent if that
 * changes. Likewise redirects re-issue against fetch's own resolver and are NOT
 * re-guarded here for v0 — note it, don't fix it yet.
 */
async function guardEgress(
    hostname: string,
    lookupFn: (h: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<string | null> {
    // A literal IP host skips DNS — check it directly.
    if (isIP(hostname)) {
        return isBlockedAddress(hostname) ? `refusing to fetch blocked address: ${hostname}` : null;
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await lookupFn(hostname);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `DNS lookup failed for ${hostname}: ${msg}`;
    }
    for (const { address } of addresses) {
        if (isBlockedAddress(address)) {
            return `refusing to fetch ${hostname} — resolves to blocked address ${address}`;
        }
    }
    return null;
}

function shapeOutput(body: string): string {
    const { content, note } = truncateTail(body, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
    if (note) return content ? `${content}\n\n${note}` : note;
    return content;
}

function htmlToMarkdown(html: string): string {
    return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(html);
}

/**
 * Build the `web_fetch` tool, optionally pinning `mode` / `selector` from `config`.
 * Pinned params are dropped from the model-facing schema (the pin); the runtime
 * effective value is pin-if-set, else the model arg, else the default.
 *
 * Note the returned `spec.name` stays `'web_fetch'` regardless of config — see the
 * name-collision dedup constraint documented at the resolution call sites in
 * `handler-from-l1.ts`. Two pinned-differently `web_fetch` nodes both resolve to
 * spec name `web_fetch` and the second is dropped (first-wins); per-config name
 * suffixes are deliberately NOT minted for v0.
 */
export function createWebFetchTool(
    config?: Record<string, unknown>,
    deps: WebFetchToolDeps = {},
): Tool {
    const pinnedMode = isValidMode(config?.mode) ? (config.mode as FetchMode) : undefined;
    const pinnedSelector =
        typeof config?.selector === 'string' && config.selector.trim().length > 0
            ? config.selector
            : undefined;

    const parameters = baseParameters();
    const props = parameters.properties as Record<string, unknown>;
    let required = parameters.required as string[];
    if (pinnedMode) {
        // Pinned mode is invisible to the model — drop it from the schema so the
        // model can't override the design-time choice.
        delete props.mode;
        required = required.filter((r) => r !== 'mode');
    }
    if (pinnedSelector) {
        delete props.selector;
        required = required.filter((r) => r !== 'selector');
    }
    parameters.required = required;

    const userAgent =
        typeof config?.user_agent === 'string' && config.user_agent.trim().length > 0
            ? config.user_agent
            : DEFAULT_USER_AGENT;
    const requestHeaders = browserHeaders(userAgent);

    const fetchFn = deps.fetchFn ?? fetch;
    const lookupFn = deps.lookupFn ?? defaultLookup;

    const spec: ToolSpec = { ...WEB_FETCH_SPEC, parameters };

    return {
        spec,
        handler: async (args, ctx): Promise<ToolResult> => {
            const rawUrl = typeof args.url === 'string' ? args.url : '';
            if (!rawUrl) {
                return { stdout: '', stderr: 'missing required argument: url', exit_code: 1 };
            }
            let parsed: URL;
            try {
                parsed = new URL(rawUrl);
            } catch {
                return { stdout: '', stderr: `invalid URL: ${rawUrl}`, exit_code: 1 };
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return {
                    stdout: '',
                    stderr: `unsupported URL scheme "${parsed.protocol}" — only http(s) is allowed`,
                    exit_code: 1,
                };
            }

            // Effective mode/selector: pin if set, else the model arg, else the
            // default (markdown / no selector).
            const mode: FetchMode =
                pinnedMode ?? (isValidMode(args.mode) ? (args.mode as FetchMode) : 'markdown');
            const selector =
                pinnedSelector ??
                (typeof args.selector === 'string' && args.selector.trim().length > 0
                    ? args.selector
                    : undefined);

            if (mode === 'soup' && !selector) {
                return { stdout: '', stderr: 'mode "soup" requires a selector', exit_code: 1 };
            }

            const blocked = await guardEgress(parsed.hostname, lookupFn);
            if (blocked) {
                return { stdout: '', stderr: blocked, exit_code: 1 };
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), WEB_FETCH_DEFAULT_TIMEOUT_MS);
            // Chain the panic button onto this fetch's own timeout controller: a
            // user stop aborts the in-flight request too, not just the timeout.
            const onStop = () => controller.abort();
            if (ctx?.signal) {
                if (ctx.signal.aborted) controller.abort();
                else ctx.signal.addEventListener('abort', onStop);
            }
            // `WEB_FETCH_MAX_TIMEOUT_MS` is the ceiling for a future per-call timeout
            // arg; today the default is the only timeout, matching the bash tool.
            void WEB_FETCH_MAX_TIMEOUT_MS;
            let res: Response;
            try {
                res = await fetchFn(parsed.toString(), {
                    signal: controller.signal,
                    redirect: 'follow',
                    headers: requestHeaders,
                });
            } catch (err) {
                const stoppedByUser = ctx?.signal?.aborted ?? false;
                const aborted = controller.signal.aborted;
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    stdout: '',
                    stderr: stoppedByUser
                        ? 'web_fetch cancelled by user'
                        : aborted
                          ? `fetch timed out after ${WEB_FETCH_DEFAULT_TIMEOUT_MS / 1000}s`
                          : `fetch failed: ${msg}`,
                    exit_code: 1,
                };
            } finally {
                clearTimeout(timer);
                ctx?.signal?.removeEventListener('abort', onStop);
            }

            if (!res.ok) {
                return {
                    stdout: '',
                    stderr: `HTTP ${res.status} ${res.statusText}`,
                    exit_code: 1,
                };
            }

            const contentType = res.headers.get('content-type') ?? '';
            const finalUrl = res.url || parsed.toString();
            const meta = `fetched ${res.status} ${contentType || '(no content-type)'} ${finalUrl}`;

            let text: string;
            try {
                text = await res.text();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `failed to read body: ${msg}`, exit_code: 1 };
            }

            if (mode === 'raw') {
                return { stdout: shapeOutput(text), stderr: meta, exit_code: 0 };
            }

            if (mode === 'json') {
                let value: unknown;
                try {
                    value = JSON.parse(text);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return { stdout: '', stderr: `not valid JSON: ${msg}`, exit_code: 1 };
                }
                return {
                    stdout: shapeOutput(JSON.stringify(value, null, 2)),
                    stderr: meta,
                    exit_code: 0,
                };
            }

            if (mode === 'soup') {
                // selector is guaranteed present (checked above).
                const $ = cheerio.load(text);
                const lines: string[] = [];
                $(selector as string).each((_, el) => {
                    const t = $(el).text().trim();
                    if (t) lines.push(t);
                });
                if (lines.length === 0) {
                    // Empty result is valid, not an error.
                    return {
                        stdout: '',
                        stderr: `no elements matched ${selector}`,
                        exit_code: 0,
                    };
                }
                return { stdout: shapeOutput(lines.join('\n')), stderr: meta, exit_code: 0 };
            }

            // markdown — readability over linkedom's light DOM, then turndown.
            // Falls back to turndown over the full <body> when readability finds
            // no article (non-article pages: dashboards, search results, etc.).
            try {
                const { document } = parseHTML(text);
                let article: { content?: string | null } | null = null;
                try {
                    // linkedom's `document` is structurally compatible with what
                    // Readability walks; the runner's tsconfig omits the DOM lib
                    // so we bridge the nominal `Document` type via `unknown`.
                    const Ctor = Readability as unknown as new (doc: unknown) => {
                        parse(): { content?: string | null } | null;
                    };
                    article = new Ctor(document).parse();
                } catch {
                    article = null;
                }
                const articleHtml = article?.content?.trim() ? article.content : null;
                const sourceHtml =
                    articleHtml ??
                    document.body?.innerHTML ??
                    document.documentElement?.innerHTML ??
                    text;
                const md = htmlToMarkdown(sourceHtml).trim();
                return { stdout: shapeOutput(md), stderr: meta, exit_code: 0 };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `markdown extraction failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}
