import { describe, expect, it } from 'vitest';
import {
    createWebFetchTool,
    WEB_FETCH_SPEC,
    isBlockedAddress,
    type WebFetchToolDeps,
} from '../../src/runtime/web-fetch-tool.js';
import type { ToolHandlerContext } from '../../src/runtime/tools.js';

const CTX: ToolHandlerContext = { call_id: 'c1', eventId: 'ev1' };

function stubFetch(opts: {
    body: string;
    status?: number;
    statusText?: string;
    contentType?: string;
    finalUrl?: string;
}): typeof fetch {
    const status = opts.status ?? 200;
    return (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: opts.statusText ?? 'OK',
            url: opts.finalUrl ?? url,
            headers: new Headers(opts.contentType ? { 'content-type': opts.contentType } : {}),
            text: async () => opts.body,
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

function publicLookup(address = '93.184.216.34'): WebFetchToolDeps['lookupFn'] {
    return async () => [{ address, family: 4 }];
}

function deps(over: Partial<WebFetchToolDeps>): WebFetchToolDeps {
    return { lookupFn: publicLookup(), ...over };
}

describe('createWebFetchTool — modes', () => {
    it('raw returns the body verbatim', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: 'hello <b>world</b>' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('hello <b>world</b>');
    });

    it('json pretty-prints valid JSON', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: '{"a":1,"b":[2,3]}' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'json' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    });

    it('json errors on invalid JSON', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: 'not json {' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'json' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/not valid JSON/);
    });

    it('markdown extracts readable content', async () => {
        const html = `<!doctype html><html><head><title>Doc</title></head><body>
            <article><h1>Title</h1><p>This is the main body paragraph with enough text to be considered an article by the readability heuristic, which needs a few hundred characters of prose before it will treat the block as the primary content of the page rather than chrome.</p></article>
            </body></html>`;
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: html, contentType: 'text/html' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'markdown' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/main body paragraph/);
        expect(r.stdout).not.toMatch(/<p>/);
    });

    it('markdown falls back to body when readability finds no article', async () => {
        const html = '<html><body><p>just one short line</p></body></html>';
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: html, contentType: 'text/html' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'markdown' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/just one short line/);
    });

    it('defaults to markdown when no mode is supplied', async () => {
        const html = '<html><body><p>defaulted</p></body></html>';
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: html, contentType: 'text/html' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/defaulted/);
    });

    it('soup returns matched element text, one per line', async () => {
        const html = '<html><body><h2>One</h2><h2> Two </h2><p>nope</p><h2></h2></body></html>';
        const tool = createWebFetchTool(undefined, deps({ fetchFn: stubFetch({ body: html }) }));
        const r = await tool.handler(
            { url: 'https://example.com', mode: 'soup', selector: 'h2' },
            CTX,
        );
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('One\nTwo');
    });

    it('soup with zero matches returns exit 0 and a stderr note', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: '<html><body><p>x</p></body></html>' }) }),
        );
        const r = await tool.handler(
            { url: 'https://example.com', mode: 'soup', selector: '.missing' },
            CTX,
        );
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stderr).toMatch(/no elements matched \.missing/);
    });

    it('soup without a selector errors', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: '<html></html>' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'soup' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/requires a selector/);
    });

    it('non-2xx maps to exit 1 with HTTP status in stderr', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: '', status: 404, statusText: 'Not Found' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toBe('HTTP 404 Not Found');
    });

    it('success stderr carries compact metadata, stdout stays clean', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({
                fetchFn: stubFetch({
                    body: '{"x":1}',
                    contentType: 'application/json',
                    finalUrl: 'https://final.example/x',
                }),
            }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'json' }, CTX);
        expect(r.stdout).toBe('{\n  "x": 1\n}');
        expect(r.stderr).toBe('fetched 200 application/json https://final.example/x');
    });
});

describe('createWebFetchTool — truncation', () => {
    it('caps output at the line budget with a truncation note', async () => {
        const body = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
        const tool = createWebFetchTool(undefined, deps({ fetchFn: stubFetch({ body }) }));
        const r = await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/\[Output truncated: showing last \d+ of 2000 lines\]/);
        expect(r.stdout).toMatch(/line 1999/);
        expect(r.stdout).not.toMatch(/line 0\b/);
    });

    it('caps output at the byte budget', async () => {
        const body = 'x'.repeat(64 * 1024);
        const tool = createWebFetchTool(undefined, deps({ fetchFn: stubFetch({ body }) }));
        const r = await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(32 * 1024 + 200);
    });
});

describe('createWebFetchTool — SSRF egress guard', () => {
    const okFetch = stubFetch({ body: 'ok' });

    it('rejects the cloud-metadata IP', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: okFetch, lookupFn: publicLookup('169.254.169.254') }),
        );
        const r = await tool.handler({ url: 'https://metadata.internal', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/blocked address 169\.254\.169\.254/);
    });

    it('rejects loopback', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: okFetch, lookupFn: publicLookup('127.0.0.1') }),
        );
        const r = await tool.handler({ url: 'http://localhost-alias', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/blocked address 127\.0\.0\.1/);
    });

    it('rejects a private-range address', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: okFetch, lookupFn: publicLookup('10.1.2.3') }),
        );
        const r = await tool.handler({ url: 'http://intranet.host', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/blocked address 10\.1\.2\.3/);
    });

    it('rejects a literal-IP loopback host without DNS', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: okFetch, lookupFn: async () => [{ address: '8.8.8.8', family: 4 }] }),
        );
        const r = await tool.handler({ url: 'http://127.0.0.1:8080/x', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/refusing to fetch blocked address: 127\.0\.0\.1/);
    });

    it('rejects non-http schemes before any network/DNS', async () => {
        let fetched = false;
        const tool = createWebFetchTool(undefined, {
            fetchFn: (async () => {
                fetched = true;
                return undefined as unknown as Response;
            }) as unknown as typeof fetch,
            lookupFn: async () => {
                throw new Error('lookup should not be called');
            },
        });
        for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://h/x']) {
            const r = await tool.handler({ url, mode: 'raw' }, CTX);
            expect(r.exit_code).toBe(1);
            expect(r.stderr).toMatch(/unsupported URL scheme/);
        }
        expect(fetched).toBe(false);
    });

    it('allows a public host', async () => {
        const tool = createWebFetchTool(
            undefined,
            deps({ fetchFn: stubFetch({ body: 'hi' }), lookupFn: publicLookup('93.184.216.34') }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('hi');
    });
});

describe('isBlockedAddress', () => {
    it('blocks loopback / private / link-local / metadata and IPv6 equivalents', () => {
        for (const a of [
            '127.0.0.1',
            '10.0.0.1',
            '172.16.5.5',
            '172.31.255.255',
            '192.168.1.1',
            '169.254.169.254',
            '0.0.0.0',
            '::1',
            'fc00::1',
            'fd12::1',
            'fe80::1',
            '::ffff:127.0.0.1',
        ]) {
            expect(isBlockedAddress(a), a).toBe(true);
        }
    });

    it('allows public addresses', () => {
        for (const a of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:2800:220:1::1']) {
            expect(isBlockedAddress(a), a).toBe(false);
        }
    });
});

describe('createWebFetchTool — schema shaping (the pin)', () => {
    function props(tool: ReturnType<typeof createWebFetchTool>): Record<string, unknown> {
        return (tool.spec.parameters as { properties: Record<string, unknown> }).properties;
    }
    function required(tool: ReturnType<typeof createWebFetchTool>): string[] {
        return (tool.spec.parameters as { required: string[] }).required;
    }

    it('no config keeps all three params', () => {
        const tool = createWebFetchTool();
        expect(Object.keys(props(tool)).sort()).toEqual(['mode', 'selector', 'url']);
        expect(required(tool)).toEqual(['url']);
    });

    it('pinned mode drops `mode` from properties and required', () => {
        const tool = createWebFetchTool({ mode: 'json' });
        expect(props(tool)).not.toHaveProperty('mode');
        expect(props(tool)).toHaveProperty('url');
        expect(required(tool)).not.toContain('mode');
    });

    it('pinned soup + selector drops both', () => {
        const tool = createWebFetchTool({ mode: 'soup', selector: '.x' });
        expect(props(tool)).not.toHaveProperty('mode');
        expect(props(tool)).not.toHaveProperty('selector');
        expect(props(tool)).toHaveProperty('url');
    });

    it('ignores an invalid pinned mode (stays model-driven)', () => {
        const tool = createWebFetchTool({ mode: 'bogus' });
        expect(props(tool)).toHaveProperty('mode');
    });

    it('a pinned mode is enforced at call time even if the model passes another', async () => {
        const tool = createWebFetchTool(
            { mode: 'raw' },
            deps({ fetchFn: stubFetch({ body: '{"a":1}' }) }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'json' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('{"a":1}');
    });

    it('WEB_FETCH_SPEC advertises the config_schema for the inspector', () => {
        expect(WEB_FETCH_SPEC.config_schema?.map((f) => f.name)).toEqual([
            'mode',
            'selector',
            'user_agent',
        ]);
        const selectorField = WEB_FETCH_SPEC.config_schema?.find((f) => f.name === 'selector');
        expect(selectorField?.showWhen).toEqual({ field: 'mode', equals: 'soup' });
    });
});

describe('createWebFetchTool — request headers', () => {
    /** Stub that records the init passed to the most recent fetch call. */
    function capturingFetch(): { fetchFn: typeof fetch; lastInit(): RequestInit | undefined } {
        let init: RequestInit | undefined;
        const fetchFn = (async (_input: RequestInfo | URL, opts?: RequestInit) => {
            init = opts;
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                url: 'https://example.com',
                headers: new Headers(),
                text: async () => 'ok',
            } as unknown as Response;
        }) as unknown as typeof fetch;
        return { fetchFn, lastInit: () => init };
    }

    function headersOf(init: RequestInit | undefined): Record<string, string> {
        return (init?.headers ?? {}) as Record<string, string>;
    }

    it('sends a desktop-browser header set by default', async () => {
        const cap = capturingFetch();
        const tool = createWebFetchTool(undefined, deps({ fetchFn: cap.fetchFn }));
        const r = await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(0);
        const h = headersOf(cap.lastInit());
        expect(h['User-Agent']).toMatch(/Mozilla\/5\.0.*Chrome/);
        expect(h.Accept).toMatch(/text\/html/);
        expect(h['Accept-Language']).toMatch(/en-US/);
        expect(h['Sec-Fetch-Mode']).toBe('navigate');
    });

    it('honors a pinned user_agent override', async () => {
        const cap = capturingFetch();
        const tool = createWebFetchTool(
            { user_agent: 'MyBot/1.0' },
            deps({ fetchFn: cap.fetchFn }),
        );
        const r = await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(headersOf(cap.lastInit())['User-Agent']).toBe('MyBot/1.0');
    });

    it('ignores a blank user_agent and keeps the default', async () => {
        const cap = capturingFetch();
        const tool = createWebFetchTool({ user_agent: '   ' }, deps({ fetchFn: cap.fetchFn }));
        await tool.handler({ url: 'https://example.com', mode: 'raw' }, CTX);
        expect(headersOf(cap.lastInit())['User-Agent']).toMatch(/Mozilla\/5\.0.*Chrome/);
    });
});
