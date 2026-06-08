import { truncateTail } from './bash-exec.js';
import type { Tool, ToolResult, ToolSpec } from './tools.js';

/**
 * Built-in `web_search` tool: given a query, return ranked web results as
 * Markdown the model can read. BYO-key — the user wires a Secret node carrying
 * the provider's API key; no key ships in the product (see
 * `docs/web-search-node.md`). v0 providers: Tavily, Brave.
 *
 * Two design splits from `web_fetch`:
 *   - `provider` is config-only AND required — the model NEVER picks it per call
 *     (it's bound to which API key is wired). It is not a model-facing param;
 *     the FE renders no "Model decides" option (the `required` config field).
 *   - the key rides the Secret seam (`resolveSecretEnv`), never config / argv /
 *     the model. The tool reads `env[<PROVIDER>_API_KEY]` at call time.
 *
 * No SSRF guard (unlike `web_fetch`): endpoints are fixed per provider, not
 * user-supplied. Output is always Markdown text — same contract as `web_fetch`.
 */

const WEB_SEARCH_PROVIDERS = ['tavily', 'brave'] as const;
type Provider = (typeof WEB_SEARCH_PROVIDERS)[number];

// Match the bash / web_fetch caps so every output-heavy tool shapes output
// identically (see `bash-exec.ts` / `web-fetch-tool.ts`).
const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_BYTES = 32 * 1024;

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

/** Env binding name the user wires a Secret to, per provider. */
const EXPECTED_ENV: Record<Provider, string> = {
    tavily: 'TAVILY_API_KEY',
    brave: 'BRAVE_API_KEY',
};

/** Optional injection seam so unit tests stub the network. */
export interface WebSearchToolDeps {
    /** Defaults to Node's global `fetch`. */
    fetchFn?: typeof fetch;
}

/** A single normalized result row both adapters reduce to. */
interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

function isProvider(value: unknown): value is Provider {
    return typeof value === 'string' && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

export const WEB_SEARCH_SPEC: ToolSpec = {
    name: 'web_search',
    description:
        'Search the web and return results as Markdown. The provider is fixed by the node ' +
        "config; wire a Secret node carrying that provider's API key (Tavily → `TAVILY_API_KEY`, " +
        'Brave → `BRAVE_API_KEY`). Use for current events, docs lookups, and facts not in context.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query.',
            },
            count: {
                type: 'integer',
                description: `Number of results to return. Defaults to ${DEFAULT_COUNT}, capped at ${MAX_COUNT}.`,
            },
        },
        required: ['query'],
        additionalProperties: false,
    },
    config_schema: [
        {
            name: 'provider',
            kind: 'enum',
            label: 'Provider',
            required: true,
            options: [...WEB_SEARCH_PROVIDERS],
            description:
                "Which search API to call. Wire a Secret with that provider's API key " +
                '(Tavily → `TAVILY_API_KEY`, Brave → `BRAVE_API_KEY`).',
        },
    ],
};

function shapeOutput(body: string): string {
    const { content, note } = truncateTail(body, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
    if (note) return content ? `${content}\n\n${note}` : note;
    return content;
}

/** Clamp the model-supplied count into `[1, MAX_COUNT]`, defaulting on absence. */
function resolveCount(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_COUNT;
    const n = Math.floor(raw);
    if (n < 1) return DEFAULT_COUNT;
    return Math.min(n, MAX_COUNT);
}

/** Render the normalized rows to the markdown contract. */
function renderResults(query: string, results: SearchResult[]): string {
    const header = `# Results for "${query}"`;
    if (results.length === 0) {
        return `${header}\n\n(no results)`;
    }
    const lines = results.map((r, i) => {
        const titled = r.title.trim() || r.url;
        const snippet = r.snippet.trim();
        const head = `${i + 1}. [${titled}](${r.url})`;
        return snippet ? `${head}\n   ${snippet}` : head;
    });
    return `${header}\n\n${lines.join('\n')}`;
}

/** Excerpt a non-2xx provider body for the error stderr (keep it short). */
function bodyExcerpt(body: string): string {
    const trimmed = body.trim().replace(/\s+/g, ' ');
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

type AdapterResult = { ok: true; results: SearchResult[] } | { ok: false; stderr: string };

async function searchTavily(
    fetchFn: typeof fetch,
    key: string,
    query: string,
    count: number,
    signal: AbortSignal,
): Promise<AdapterResult> {
    const res = await fetchFn('https://api.tavily.com/search', {
        method: 'POST',
        signal,
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            query,
            max_results: count,
            search_depth: 'basic',
            include_answer: false,
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, stderr: `tavily returned HTTP ${res.status}: ${bodyExcerpt(body)}` };
    }
    const json = (await res.json()) as {
        results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
    };
    const results: SearchResult[] = (json.results ?? []).map((r) => ({
        title: typeof r.title === 'string' ? r.title : '',
        url: typeof r.url === 'string' ? r.url : '',
        snippet: typeof r.content === 'string' ? r.content : '',
    }));
    return { ok: true, results };
}

async function searchBrave(
    fetchFn: typeof fetch,
    key: string,
    query: string,
    count: number,
    signal: AbortSignal,
): Promise<AdapterResult> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    const res = await fetchFn(url.toString(), {
        method: 'GET',
        signal,
        headers: {
            'X-Subscription-Token': key,
            Accept: 'application/json',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, stderr: `brave returned HTTP ${res.status}: ${bodyExcerpt(body)}` };
    }
    const json = (await res.json()) as {
        web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
    };
    const results: SearchResult[] = (json.web?.results ?? []).map((r) => ({
        title: typeof r.title === 'string' ? r.title : '',
        url: typeof r.url === 'string' ? r.url : '',
        snippet: typeof r.description === 'string' ? r.description : '',
    }));
    return { ok: true, results };
}

/**
 * Build the `web_search` tool. `config.provider` is config-only + required;
 * the API key is resolved late from the wired Secret env via `resolveSecretEnv`
 * (so a rotated key is picked up on the next call without rebuilding the
 * handler — see `handler-from-l1.ts`). Both deps default to live wiring; tests
 * stub `fetchFn` and pass a `resolveSecretEnv` returning the key env.
 */
export function createWebSearchTool(
    config?: Record<string, unknown>,
    resolveSecretEnv?: () => Record<string, string>,
    deps: WebSearchToolDeps = {},
): Tool {
    const fetchFn = deps.fetchFn ?? fetch;
    // Provider is design-time + required: read it from config, never the model.
    const provider = isProvider(config?.provider) ? (config.provider as Provider) : null;

    return {
        spec: WEB_SEARCH_SPEC,
        handler: async (args, ctx): Promise<ToolResult> => {
            if (!provider) {
                return {
                    stdout: '',
                    stderr: 'web_search: no provider configured (pin one in the node inspector)',
                    exit_code: 1,
                };
            }

            const query = typeof args.query === 'string' ? args.query.trim() : '';
            if (!query) {
                return { stdout: '', stderr: 'missing required argument: query', exit_code: 1 };
            }
            const count = resolveCount(args.count);

            const env = resolveSecretEnv?.() ?? {};
            const envName = EXPECTED_ENV[provider];
            const key = env[envName];
            if (!key) {
                return {
                    stdout: '',
                    stderr: `web_search: no API key wired for ${provider} — attach a Secret node binding \`${envName}\`.`,
                    exit_code: 1,
                };
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), WEB_SEARCH_DEFAULT_TIMEOUT_MS);
            // Chain the panic button onto the timeout controller — a user stop
            // aborts the in-flight search request, not just the timeout.
            const onStop = () => controller.abort();
            if (ctx?.signal) {
                if (ctx.signal.aborted) controller.abort();
                else ctx.signal.addEventListener('abort', onStop);
            }
            let outcome: AdapterResult;
            try {
                outcome =
                    provider === 'tavily'
                        ? await searchTavily(fetchFn, key, query, count, controller.signal)
                        : await searchBrave(fetchFn, key, query, count, controller.signal);
            } catch (err) {
                const stoppedByUser = ctx?.signal?.aborted ?? false;
                const aborted = controller.signal.aborted;
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    stdout: '',
                    stderr: stoppedByUser
                        ? 'web_search cancelled by user'
                        : aborted
                          ? `web_search timed out after ${WEB_SEARCH_DEFAULT_TIMEOUT_MS / 1000}s`
                          : `web_search failed: ${msg}`,
                    exit_code: 1,
                };
            } finally {
                clearTimeout(timer);
                ctx?.signal?.removeEventListener('abort', onStop);
            }

            if (!outcome.ok) {
                return { stdout: '', stderr: outcome.stderr, exit_code: 1 };
            }

            const stdout = shapeOutput(renderResults(query, outcome.results));
            return {
                stdout,
                stderr: `searched ${provider} ${outcome.results.length} results`,
                exit_code: 0,
            };
        },
    };
}
