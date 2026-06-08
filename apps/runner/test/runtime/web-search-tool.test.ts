import { describe, expect, it } from 'vitest';
import {
    createWebSearchTool,
    WEB_SEARCH_SPEC,
    type WebSearchToolDeps,
} from '../../src/runtime/web-search-tool.js';
import type { ToolHandlerContext } from '../../src/runtime/tools.js';

const CTX: ToolHandlerContext = { call_id: 'c1', eventId: 'ev1' };

function stubFetch(opts: {
    json?: unknown;
    body?: string;
    status?: number;
    capture?: { url?: string; init?: RequestInit };
}): typeof fetch {
    const status = opts.status ?? 200;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (opts.capture) {
            opts.capture.url = typeof input === 'string' ? input : input.toString();
            opts.capture.init = init;
        }
        const bodyText = opts.body ?? JSON.stringify(opts.json ?? {});
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => bodyText,
            json: async () => JSON.parse(bodyText),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

function deps(fetchFn: typeof fetch): WebSearchToolDeps {
    return { fetchFn };
}

const tavilyKey = (): (() => Record<string, string>) => () => ({ TAVILY_API_KEY: 'tvly-secret' });
const braveKey = (): (() => Record<string, string>) => () => ({ BRAVE_API_KEY: 'brave-secret' });

describe('createWebSearchTool — Tavily happy path', () => {
    it('renders the ranked markdown list and reports metadata on stderr', async () => {
        const capture: { url?: string; init?: RequestInit } = {};
        const fetchFn = stubFetch({
            capture,
            json: {
                results: [
                    { title: 'First', url: 'https://a.example/1', content: 'snippet one' },
                    { title: 'Second', url: 'https://b.example/2', content: 'snippet two' },
                ],
            },
        });
        const tool = createWebSearchTool({ provider: 'tavily' }, tavilyKey(), deps(fetchFn));
        const r = await tool.handler({ query: 'cats' }, CTX);

        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe(
            '# Results for "cats"\n\n' +
                '1. [First](https://a.example/1)\n   snippet one\n' +
                '2. [Second](https://b.example/2)\n   snippet two',
        );
        expect(r.stderr).toBe('searched tavily 2 results');

        expect(capture.url).toBe('https://api.tavily.com/search');
        expect(capture.init?.method).toBe('POST');
        const headers = capture.init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tvly-secret');
        const sentBody = JSON.parse(capture.init?.body as string);
        expect(sentBody).toMatchObject({
            query: 'cats',
            search_depth: 'basic',
            include_answer: false,
        });
    });
});

describe('createWebSearchTool — Brave happy path', () => {
    it('renders the ranked markdown list from web.results (description as snippet)', async () => {
        const capture: { url?: string; init?: RequestInit } = {};
        const fetchFn = stubFetch({
            capture,
            json: {
                web: {
                    results: [
                        { title: 'Brave One', url: 'https://c.example/1', description: 'desc one' },
                    ],
                },
            },
        });
        const tool = createWebSearchTool({ provider: 'brave' }, braveKey(), deps(fetchFn));
        const r = await tool.handler({ query: 'dogs', count: 3 }, CTX);

        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe(
            '# Results for "dogs"\n\n1. [Brave One](https://c.example/1)\n   desc one',
        );
        expect(r.stderr).toBe('searched brave 1 results');

        expect(capture.init?.method).toBe('GET');
        expect(capture.url).toMatch(/^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
        expect(capture.url).toMatch(/[?&]q=dogs/);
        expect(capture.url).toMatch(/[?&]count=3/);
        const headers = capture.init?.headers as Record<string, string>;
        expect(headers['X-Subscription-Token']).toBe('brave-secret');
        expect(headers.Accept).toBe('application/json');
    });
});

describe('createWebSearchTool — refusals', () => {
    it('no provider configured → exit 1 with an actionable stderr', async () => {
        const tool = createWebSearchTool(undefined, tavilyKey(), deps(stubFetch({ json: {} })));
        const r = await tool.handler({ query: 'x' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toBe('web_search: no provider configured (pin one in the node inspector)');
    });

    it('invalid provider value → treated as unset → exit 1', async () => {
        const tool = createWebSearchTool(
            { provider: 'duckduckgo' },
            tavilyKey(),
            deps(stubFetch({ json: {} })),
        );
        const r = await tool.handler({ query: 'x' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/no provider configured/);
    });

    it('missing API key → exit 1 naming the env binding to wire', async () => {
        const tool = createWebSearchTool(
            { provider: 'tavily' },
            () => ({}), // no secret wired
            deps(stubFetch({ json: { results: [] } })),
        );
        const r = await tool.handler({ query: 'x' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toBe(
            'web_search: no API key wired for tavily — attach a Secret node binding `TAVILY_API_KEY`.',
        );
    });

    it('missing query → exit 1', async () => {
        const tool = createWebSearchTool(
            { provider: 'tavily' },
            tavilyKey(),
            deps(stubFetch({ json: { results: [] } })),
        );
        const r = await tool.handler({}, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument: query/);
    });

    it('provider non-2xx → exit 1 with status + body excerpt', async () => {
        const tool = createWebSearchTool(
            { provider: 'tavily' },
            tavilyKey(),
            deps(stubFetch({ status: 401, body: '{"error":"unauthorized"}' })),
        );
        const r = await tool.handler({ query: 'x' }, CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/^tavily returned HTTP 401:/);
        expect(r.stderr).toMatch(/unauthorized/);
    });
});

describe('createWebSearchTool — zero results', () => {
    it('exit 0 with the "(no results)" body', async () => {
        const tool = createWebSearchTool(
            { provider: 'tavily' },
            tavilyKey(),
            deps(stubFetch({ json: { results: [] } })),
        );
        const r = await tool.handler({ query: 'nothing here' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('# Results for "nothing here"\n\n(no results)');
        expect(r.stderr).toBe('searched tavily 0 results');
    });
});

describe('createWebSearchTool — truncation', () => {
    it('caps output at the line budget with a truncation note', async () => {
        const results = Array.from({ length: 400 }, (_, i) => ({
            title: `Title ${i}`,
            url: `https://e.example/${i}`,
            content: `snippet line ${i}`,
        }));
        const tool = createWebSearchTool(
            { provider: 'tavily' },
            tavilyKey(),
            deps(stubFetch({ json: { results } })),
        );
        const r = await tool.handler({ query: 'many' }, CTX);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/\[Output truncated: showing last \d+ of \d+ lines\]/);
        expect(r.stdout).toMatch(/Title 399/);
        expect(r.stdout).not.toMatch(/# Results for/);
    });
});

describe('WEB_SEARCH_SPEC', () => {
    it('advertises a required, config-only provider enum and no provider param', () => {
        const provider = WEB_SEARCH_SPEC.config_schema?.find((f) => f.name === 'provider');
        expect(provider?.required).toBe(true);
        expect(provider?.options).toEqual(['tavily', 'brave']);
        const props = (WEB_SEARCH_SPEC.parameters as { properties: Record<string, unknown> })
            .properties;
        expect(Object.keys(props).sort()).toEqual(['count', 'query']);
        expect(props).not.toHaveProperty('provider');
    });
});
