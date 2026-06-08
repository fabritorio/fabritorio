import { describe, expect, it } from 'vitest';
import {
    ModelInvocationError,
    type CompleteChunk,
    type CompleteRequest,
    type ModelClient,
} from '../../../src/runtime/model.js';
import {
    classifyError,
    createRouterClient,
    shouldFallThrough,
    type RouterEvent,
} from '../../../src/runtime/providers/router.js';

function makeClient(impl: (req: CompleteRequest) => AsyncIterable<CompleteChunk>): {
    client: ModelClient;
    calls: CompleteRequest[];
} {
    const calls: CompleteRequest[] = [];
    const client: ModelClient = {
        complete(req) {
            calls.push(req);
            return impl(req);
        },
    };
    return { client, calls };
}

function yieldingClient(chunks: CompleteChunk[]) {
    return makeClient(async function* () {
        for (const c of chunks) yield c;
    });
}

function preStreamFailing(err: unknown) {
    return makeClient(
        (): AsyncIterable<CompleteChunk> => ({
            [Symbol.asyncIterator]: () => ({
                next(): Promise<IteratorResult<CompleteChunk>> {
                    return Promise.reject(err);
                },
            }),
        }),
    );
}

function baseReq(): CompleteRequest {
    return {
        model: 'router-input-model',
        messages: [{ role: 'user', content: 'hi' }],
    };
}

async function drain(iter: AsyncIterable<CompleteChunk>): Promise<CompleteChunk[]> {
    const out: CompleteChunk[] = [];
    for await (const chunk of iter) out.push(chunk);
    return out;
}

describe('createRouterClient — failover', () => {
    it('happy path: first child yields, router yields its chunks, no fall-through', async () => {
        const a = yieldingClient([{ delta: 'hello' }, { delta: '', finish_reason: 'stop' }]);
        const b = yieldingClient([{ delta: 'unused' }]);
        const events: RouterEvent[] = [];
        const router = createRouterClient({
            routerId: 'r1',
            policy: 'failover',
            children: [
                { nodeId: 'm_a', modelId: 'gpt-4', client: a.client },
                { nodeId: 'm_b', modelId: 'llama-local', client: b.client },
            ],
            emit: (e) => events.push(e),
        });

        const chunks = await drain(router.complete(baseReq()));

        expect(chunks).toEqual([{ delta: 'hello' }, { delta: '', finish_reason: 'stop' }]);
        expect(a.calls.length).toBe(1);
        expect(b.calls.length).toBe(0);
        expect(events.map((e) => e.type)).toEqual(['model_router.attempted']);
    });

    it('pre-stream 429 on first child → falls through to second, emits fell_through', async () => {
        const rateLimit = Object.assign(new Error('too many'), { status: 429 });
        const a = preStreamFailing(rateLimit);
        const b = yieldingClient([{ delta: 'from-b' }, { delta: '', finish_reason: 'stop' }]);
        const events: RouterEvent[] = [];
        const router = createRouterClient({
            routerId: 'r1',
            policy: 'failover',
            children: [
                { nodeId: 'm_a', modelId: 'gpt-4', client: a.client },
                { nodeId: 'm_b', modelId: 'llama-local', client: b.client },
            ],
            emit: (e) => events.push(e),
        });

        const chunks = await drain(router.complete(baseReq()));

        expect(chunks).toEqual([{ delta: 'from-b' }, { delta: '', finish_reason: 'stop' }]);
        expect(a.calls.length).toBe(1);
        expect(b.calls.length).toBe(1);
        const types = events.map((e) => e.type);
        expect(types).toEqual([
            'model_router.attempted',
            'model_router.fell_through',
            'model_router.attempted',
        ]);
        const fell = events[1];
        if (fell.type !== 'model_router.fell_through') throw new Error('expected fell_through');
        expect(fell.fromModelNodeId).toBe('m_a');
        expect(fell.toModelNodeId).toBe('m_b');
        expect(fell.reason).toBe('429 Too Many Requests');
    });

    it('400 on first child → propagates, second child untouched', async () => {
        const badReq = Object.assign(new Error('bad request'), { status: 400 });
        const a = preStreamFailing(badReq);
        const b = yieldingClient([{ delta: 'should-not-run' }]);
        const events: RouterEvent[] = [];
        const router = createRouterClient({
            routerId: 'r1',
            policy: 'failover',
            children: [
                { nodeId: 'm_a', modelId: 'gpt-4', client: a.client },
                { nodeId: 'm_b', modelId: 'llama-local', client: b.client },
            ],
            emit: (e) => events.push(e),
        });

        await expect(drain(router.complete(baseReq()))).rejects.toThrow('bad request');
        expect(b.calls.length).toBe(0);
        expect(events.some((e) => e.type === 'model_router.fell_through')).toBe(false);
    });

    it('mid-stream error after first chunk → propagates, no fall-through', async () => {
        const a = makeClient(async function* () {
            yield { delta: 'partial' };
            throw Object.assign(new Error('stream blew up'), { status: 503 });
        });
        const b = yieldingClient([{ delta: 'should-not-run' }]);
        const events: RouterEvent[] = [];
        const router = createRouterClient({
            routerId: 'r1',
            policy: 'failover',
            children: [
                { nodeId: 'm_a', modelId: 'gpt-4', client: a.client },
                { nodeId: 'm_b', modelId: 'llama-local', client: b.client },
            ],
            emit: (e) => events.push(e),
        });

        const collected: CompleteChunk[] = [];
        await expect(
            (async () => {
                for await (const c of router.complete(baseReq())) collected.push(c);
            })(),
        ).rejects.toThrow('stream blew up');

        expect(collected).toEqual([{ delta: 'partial' }]);
        expect(b.calls.length).toBe(0);
        expect(events.some((e) => e.type === 'model_router.fell_through')).toBe(false);
    });

    it('all children fail pre-stream → throws ModelInvocationError mentioning each reason', async () => {
        const err429 = Object.assign(new Error('rate'), { status: 429 });
        const errNet = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        const a = preStreamFailing(err429);
        const b = preStreamFailing(errNet);
        const router = createRouterClient({
            routerId: 'r1',
            policy: 'failover',
            children: [
                { nodeId: 'm_a', modelId: 'gpt-4', client: a.client },
                { nodeId: 'm_b', modelId: 'llama-local', client: b.client },
            ],
        });

        let caught: unknown;
        try {
            await drain(router.complete(baseReq()));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ModelInvocationError);
        const msg = (caught as Error).message;
        expect(msg).toContain('m_a');
        expect(msg).toContain('429 Too Many Requests');
        expect(msg).toContain('m_b');
        expect(msg).toContain('ECONNREFUSED');
    });

    it('request `model` is rewritten per child — each sees its own modelId', async () => {
        const err429 = Object.assign(new Error('rate'), { status: 429 });
        const a = preStreamFailing(err429);
        const b = yieldingClient([{ delta: 'ok' }, { delta: '', finish_reason: 'stop' }]);
        const router = createRouterClient({
            routerId: 'r1',
            policy: 'failover',
            children: [
                { nodeId: 'm_a', modelId: 'gpt-4o', client: a.client },
                { nodeId: 'm_b', modelId: 'llama-3.1-8b', client: b.client },
            ],
        });

        await drain(router.complete(baseReq()));
        expect(a.calls[0]?.model).toBe('gpt-4o');
        expect(b.calls[0]?.model).toBe('llama-3.1-8b');
    });

    it('empty children array → throws at construction', () => {
        expect(() =>
            createRouterClient({
                routerId: 'r1',
                policy: 'failover',
                children: [],
            }),
        ).toThrow(/no children/);
    });

    it('unknown policy → throws at construction', () => {
        expect(() =>
            createRouterClient({
                routerId: 'r1',
                // @ts-expect-error — intentionally bad policy
                policy: 'round_robin',
                children: [{ nodeId: 'm_a', modelId: 'gpt-4', client: yieldingClient([]).client }],
            }),
        ).toThrow(/not implemented/);
    });

    it('classifyError: reads status from `.cause` chain (openai-compat shape)', () => {
        const wrapped = new ModelInvocationError(
            'rate-limited',
            Object.assign(new Error('inner'), { status: 429 }),
        );
        const cls = classifyError(wrapped);
        expect(cls.fallThrough).toBe(true);
        expect(cls.reason).toBe('429 Too Many Requests');
    });

    it('classifyError: reads network code from `.cause.cause` (APIConnectionError shape)', () => {
        const fetchErr = Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
        });
        const apiErr = new Error('Connection error');
        (apiErr as Error & { cause?: unknown }).cause = fetchErr;
        const wrapped = new ModelInvocationError('connection error', apiErr);
        expect(classifyError(wrapped).fallThrough).toBe(true);
        expect(classifyError(wrapped).reason).toBe('ECONNREFUSED');
    });

    it('classifyError: parses status from gemini-style message string', () => {
        const err = new ModelInvocationError('gemini 429: quota exceeded');
        const cls = classifyError(err);
        expect(cls.fallThrough).toBe(true);
        expect(cls.reason).toBe('429 Too Many Requests');
    });

    it('classifyError: 400 in gemini-style message propagates', () => {
        const err = new ModelInvocationError('gemini 400: invalid request');
        expect(classifyError(err).fallThrough).toBe(false);
    });

    it('shouldFallThrough is the boolean projection of classifyError', () => {
        const rl = Object.assign(new Error('x'), { status: 429 });
        const br = Object.assign(new Error('x'), { status: 400 });
        expect(shouldFallThrough(rl)).toBe(true);
        expect(shouldFallThrough(br)).toBe(false);
    });
});
