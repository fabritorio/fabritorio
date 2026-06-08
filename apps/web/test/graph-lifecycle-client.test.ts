import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunnerClient } from '../lib/runner-client';

type FetchArgs = { url: string; init?: RequestInit };

function installFetch(handler: (args: FetchArgs) => Response): FetchArgs[] {
    const calls: FetchArgs[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
        url: string,
        init?: RequestInit,
    ) => {
        if (url.endsWith('/bootstrap')) {
            return new Response(JSON.stringify({ token: 'test-token', version: '0' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        const args = { url, init };
        calls.push(args);
        return handler(args);
    }) as unknown as typeof fetch;
    return calls;
}

beforeEach(() => {
    vi.restoreAllMocks();
});

afterEach(() => {
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('runner-client liveness surface', () => {
    it('activateGraph POSTs /activate and resolves on 200', async () => {
        const calls = installFetch(
            () =>
                new Response(JSON.stringify({ id: 'g1', status: 'running' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const client = createRunnerClient('http://runner.test');

        await expect(client.activateGraph('g1')).resolves.toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://runner.test/graphs/g1/activate');
        expect(calls[0]!.init?.method).toBe('POST');
    });

    it('stopGraph POSTs /stop and resumeGraph POSTs /resume', async () => {
        const calls = installFetch(
            () =>
                new Response(JSON.stringify({ id: 'g1', status: 'stopped' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const client = createRunnerClient('http://runner.test');

        await client.stopGraph('g1');
        await client.resumeGraph('g1');
        expect(calls.map((c) => c.url)).toEqual([
            'http://runner.test/graphs/g1/stop',
            'http://runner.test/graphs/g1/resume',
        ]);
    });

    it('stopDispatch POSTs /dispatches/:eventId/stop and returns { ok: true }', async () => {
        const calls = installFetch(
            () =>
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const client = createRunnerClient('http://runner.test');

        await expect(client.stopDispatch('evt-1')).resolves.toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://runner.test/dispatches/evt-1/stop');
        expect(calls[0]!.init?.method).toBe('POST');
    });

    it('stopDispatch treats 404 (dispatch already finished) as a non-throwing no-op', async () => {
        installFetch(() => new Response('not found', { status: 404, statusText: 'Not Found' }));
        const client = createRunnerClient('http://runner.test');

        await expect(client.stopDispatch('evt-gone')).resolves.toEqual({ ok: false });
    });

    it('stopDispatch encodes the eventId in the path', async () => {
        const calls = installFetch(
            () =>
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const client = createRunnerClient('http://runner.test');

        await client.stopDispatch('evt/with space');
        expect(calls[0]!.url).toBe('http://runner.test/dispatches/evt%2Fwith%20space/stop');
    });

    it('activateGraph rejects when the route errors (e.g. 404 missing graph)', async () => {
        installFetch(() => new Response('not found', { status: 404, statusText: 'Not Found' }));
        const client = createRunnerClient('http://runner.test');

        await expect(client.activateGraph('missing')).rejects.toThrow(/404/);
    });

    it('listGraphs surfaces the BE-derived status as GraphSummary.liveness', async () => {
        installFetch(
            () =>
                new Response(
                    JSON.stringify({
                        graphs: [
                            { id: 'a', kind: 'l2', nodes: [], edges: [], status: 'running' },
                            { id: 'b', kind: 'l2', nodes: [], edges: [], status: 'stopped' },
                            { id: 'c', kind: 'l2', nodes: [], edges: [] },
                        ],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
        );
        const client = createRunnerClient('http://runner.test');

        const list = await client.listGraphs();
        expect(list.map((g) => [g.id, g.liveness])).toEqual([
            ['a', 'running'],
            ['b', 'stopped'],
            ['c', 'idle'],
        ]);
        expect((list[0]!.graph as { status?: unknown }).status).toBeUndefined();
    });
});
