import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    DispatchEvent,
    LlmRequestEvent,
    ObservabilityEvent,
    OutputEmittedEvent,
} from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { inject } from '../helpers/inject.js';

const NODE_ID = 'agent-a';
const ROOT_EVENT_ID_A = 'evt-root-a';
const ROOT_EVENT_ID_B = 'evt-root-b';

interface WireEnvelope {
    seq: number;
    kind: 'dispatch' | 'observability';
    payload: DispatchEvent | ObservabilityEvent;
}

function dispatch(eventId: string, source = 'test', timestamp = 1000): DispatchEvent {
    return { eventId, source, timestamp, messages: [{ role: 'user', content: 'hi' }] };
}

function llmRequest(eventId: string, ts: string): LlmRequestEvent {
    return {
        type: 'llm.request',
        ts,
        eventId,
        node_id: NODE_ID,
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
    };
}

function outputEmitted(
    eventId: string,
    port: 'result' | 'error',
    content: string,
    ts: string,
): OutputEmittedEvent {
    return {
        type: 'output.emitted',
        ts,
        eventId,
        parentId: eventId,
        node_id: NODE_ID,
        port,
        port_id: port,
        messages: [{ role: 'assistant', content }],
    };
}

type BuiltServer = ReturnType<typeof buildServer>;

interface BootResult {
    app: BuiltServer;
    bus: ReturnType<typeof createEventBus>;
    cleanup(): Promise<void>;
}

function boot(dir: string): BootResult {
    const graphStore = createGraphStore({ dir });
    const bus = createEventBus();
    const nodes = createNodeRegistry();
    nodes.register('native_agent', { receiver: () => () => undefined });
    nodes.register('channel', { receiver: () => () => undefined });
    const runtimes = createGraphRuntimeRegistry({ bus, nodes });
    const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });
    return {
        app,
        bus,
        async cleanup() {
            await app.close();
        },
    };
}

interface ReplayBody {
    events: WireEnvelope[];
    max: number;
}

async function replay(app: BuiltServer, query = ''): Promise<ReplayBody> {
    const res = await inject(app, {
        method: 'GET',
        url: `/api/observability/replay${query}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ReplayBody;
}

describe('GET /observability/replay', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-observability-replay-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('empty: no events → { events: [], max: -1 }', async () => {
        const b = boot(dir);
        try {
            const body = await replay(b.app);
            expect(body.events).toEqual([]);
            expect(body.max).toBe(-1);
        } finally {
            await b.cleanup();
        }
    });

    it('basic tail + max: returns all events in order with global seq and kind', async () => {
        const b = boot(dir);
        try {
            b.bus.emitDispatch(dispatch(ROOT_EVENT_ID_A));
            b.bus.emitObservability(llmRequest(ROOT_EVENT_ID_A, new Date(1100).toISOString()));
            b.bus.emitDispatch(dispatch(ROOT_EVENT_ID_B, 'other', 1150));
            b.bus.emitObservability(
                outputEmitted(ROOT_EVENT_ID_A, 'result', 'done', new Date(1200).toISOString()),
            );

            const body = await replay(b.app);
            expect(body.events).toHaveLength(4);
            expect(body.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
            expect(body.events.map((e) => e.kind)).toEqual([
                'dispatch',
                'observability',
                'dispatch',
                'observability',
            ]);
            expect((body.events[0]!.payload as DispatchEvent).eventId).toBe(ROOT_EVENT_ID_A);
            expect((body.events[2]!.payload as DispatchEvent).eventId).toBe(ROOT_EVENT_ID_B);
            expect(body.max).toBe(3);
        } finally {
            await b.cleanup();
        }
    });

    it('tail cap: default caps the window; ?tail=N honors a smaller window', async () => {
        const N = 1000;
        const b = boot(dir);
        try {
            for (let i = 0; i < N; i++) {
                b.bus.emitDispatch(dispatch(`cap-evt-${i}`, 'cap', 2000 + i));
            }

            const body = await replay(b.app);
            expect(body.events.length).toBeLessThan(N);
            expect(body.events[0]!.seq).toBeGreaterThan(0);
            expect(body.events[body.events.length - 1]!.seq).toBe(N - 1);
            for (let i = 1; i < body.events.length; i++) {
                expect(body.events[i]!.seq).toBe(body.events[i - 1]!.seq + 1);
            }
            expect(body.max).toBe(N - 1);

            const small = await replay(b.app, '?tail=10');
            expect(small.events).toHaveLength(10);
            expect(small.events[0]!.seq).toBe(N - 10);
            expect(small.events[small.events.length - 1]!.seq).toBe(N - 1);
            expect(small.max).toBe(N - 1);
        } finally {
            await b.cleanup();
        }
    });

    it('ancestor stitch: a root Dispatch off the window is prepended before its obs events', async () => {
        const N = 700;
        const b = boot(dir);
        try {
            const OLD_ROOT = 'old-root';
            b.bus.emitDispatch(dispatch(OLD_ROOT, 'webchat:c1', 1000));

            for (let i = 0; i < N; i++) {
                b.bus.emitDispatch(dispatch(`filler-${i}`, 'filler', 2000 + i));
            }

            b.bus.emitObservability(llmRequest(OLD_ROOT, new Date(3000).toISOString()));
            b.bus.emitObservability(
                outputEmitted(OLD_ROOT, 'result', 'done', new Date(3001).toISOString()),
            );

            const body = await replay(b.app);
            const rootEnv = body.events.find(
                (env) =>
                    env.kind === 'dispatch' && (env.payload as DispatchEvent).eventId === OLD_ROOT,
            );
            expect(rootEnv).toBeDefined();
            expect(rootEnv!.seq).toBe(0);

            const obsEnvs = body.events.filter(
                (env) =>
                    env.kind === 'observability' &&
                    (env.payload as ObservabilityEvent).eventId === OLD_ROOT,
            );
            expect(obsEnvs.length).toBeGreaterThanOrEqual(2);
            const rootPos = body.events.indexOf(rootEnv!);
            for (const obs of obsEnvs) {
                expect(body.events.indexOf(obs)).toBeGreaterThan(rootPos);
            }
        } finally {
            await b.cleanup();
        }
    });
});
