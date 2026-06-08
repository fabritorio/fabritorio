import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    ChainStoppedEvent,
    DispatchEvent,
    Graph,
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
const CHANNEL_ID = 'ch';
const ROOT_EVENT_ID = 'evt-root-1';

let bootToken = '';

type BuiltServer = ReturnType<typeof buildServer>;

interface SsePart {
    event: string;
    data: unknown;
}

interface WireEnvelope {
    seq: number;
    kind: 'dispatch' | 'observability';
    payload: DispatchEvent | ObservabilityEvent;
}

interface EndEnvelope {
    reason: 'success' | 'stopped';
    terminalSeq: number;
}

function singleNodeGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'dispatches-stream',
        nodes: [
            {
                id: NODE_ID,
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 0, y: 0 },
            },
            {
                id: CHANNEL_ID,
                type: 'channel',
                channel_kind: 'webchat',
                position: { x: 200, y: 0 },
            },
        ],
        edges: [],
    };
}

function dispatch(
    eventId: string,
    source = 'test',
    timestamp = 1000,
    extra: Partial<DispatchEvent> = {},
): DispatchEvent {
    return {
        eventId,
        source,
        timestamp,
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
    };
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

function chainStopped(eventId: string, ts: string, reason = 'cancelled'): ChainStoppedEvent {
    return {
        type: 'chain.stopped',
        ts,
        eventId,
        node_id: NODE_ID,
        reason,
    };
}

interface BootResult {
    app: BuiltServer;
    bus: ReturnType<typeof createEventBus>;
    runtimes: ReturnType<typeof createGraphRuntimeRegistry>;
    graphId: string;
    port: number;
    cleanup(): Promise<void>;
}

async function bootListening(dir: string): Promise<BootResult> {
    const graphStore = createGraphStore({ dir });
    const bus = createEventBus();
    const nodes = createNodeRegistry();
    nodes.register('native_agent', { receiver: () => () => undefined });
    nodes.register('channel', { receiver: () => () => undefined });
    const runtimes = createGraphRuntimeRegistry({ bus, nodes });
    const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes });

    const create = await inject(app, {
        method: 'POST',
        url: '/api/graphs',
        payload: singleNodeGraph(),
    });
    const graphId = (create.json() as { graph: Graph }).graph.id!;
    const load = await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/load` });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = new URL(address);
    const port = Number.parseInt(url.port, 10);
    bootToken = app.fabToken;

    return {
        app,
        bus,
        runtimes,
        graphId,
        port,
        async cleanup() {
            await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/unload` });
            await app.close();
        },
    };
}

interface StreamHandle {
    parts: SsePart[];
    waitFor(pred: (parts: SsePart[]) => boolean, timeoutMs?: number): Promise<void>;
    abort(): void;
    response: Response;
}

async function openStream(port: number, graphId: string, eventId: string): Promise<StreamHandle> {
    const controller = new AbortController();
    const response = await fetch(
        `http://127.0.0.1:${port}/api/graphs/${graphId}/dispatches/${eventId}/stream`,
        {
            headers: { accept: 'text/event-stream', 'x-fabritorio-token': bootToken },
            signal: controller.signal,
        },
    );
    if (!response.body) throw new Error('no response body');

    const parts: SsePart[] = [];
    let buffer = '';

    void (async () => {
        try {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    if (frame.startsWith(':') || frame.trim().length === 0) continue;
                    const lines = frame.split('\n');
                    let event = 'message';
                    let dataRaw = '';
                    for (const line of lines) {
                        if (line.startsWith('event: ')) event = line.slice(7);
                        else if (line.startsWith('data: ')) dataRaw += line.slice(6);
                    }
                    try {
                        parts.push({ event, data: JSON.parse(dataRaw) });
                    } catch {
                        parts.push({ event, data: dataRaw });
                    }
                }
            }
        } catch {
            // aborted or closed — fine
        }
    })();

    const waitFor = async (pred: (parts: SsePart[]) => boolean, timeoutMs = 1500) => {
        const start = Date.now();
        while (!pred(parts)) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(
                    `timeout waiting for predicate; got parts=${JSON.stringify(parts)}`,
                );
            }
            await new Promise((r) => setTimeout(r, 10));
        }
    };

    const abort = () => {
        try {
            controller.abort();
        } catch {
            // ignore
        }
    };

    return { parts, waitFor, abort, response };
}

function eventParts(parts: SsePart[]): WireEnvelope[] {
    return parts.filter((p) => p.event === 'event').map((p) => p.data as WireEnvelope);
}

function endPart(parts: SsePart[]): EndEnvelope | null {
    const hit = parts.find((p) => p.event === 'end');
    return hit ? (hit.data as EndEnvelope) : null;
}

describe('/graphs/:id/dispatches/:eventId/stream', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-dispatches-sse-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('snapshot-only path: dispatch terminated before subscribe — replay everything then end', async () => {
        const boot = await bootListening(dir);
        try {
            boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
            boot.bus.emitObservability(llmRequest(ROOT_EVENT_ID, new Date(1100).toISOString()));
            boot.bus.emitObservability(
                outputEmitted(ROOT_EVENT_ID, 'result', 'all done', new Date(1200).toISOString()),
            );

            const stream = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await stream.waitFor((p) => p.some((part) => part.event === 'end'));

            const events = eventParts(stream.parts);
            expect(events).toHaveLength(3);
            expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
            expect(events[0]!.kind).toBe('dispatch');
            expect(events[1]!.kind).toBe('observability');
            expect((events[1]!.payload as ObservabilityEvent).type).toBe('llm.request');
            expect((events[2]!.payload as ObservabilityEvent).type).toBe('output.emitted');

            const end = endPart(stream.parts);
            expect(end).toEqual({ reason: 'success', terminalSeq: 2 });
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('race-window: events emitted between subscribe and snapshot land exactly once at correct seq', async () => {
        const boot = await bootListening(dir);
        try {
            const realSubscribeDispatch = boot.bus.subscribeDispatch.bind(boot.bus);
            let raced = false;
            boot.bus.subscribeDispatch = (listener) => {
                const off = realSubscribeDispatch(listener);
                if (!raced) {
                    raced = true;
                    boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
                    boot.bus.emitObservability(
                        llmRequest(ROOT_EVENT_ID, new Date(1100).toISOString()),
                    );
                }
                return off;
            };

            const stream = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await new Promise((r) => setTimeout(r, 30));
            boot.bus.emitObservability(
                outputEmitted(ROOT_EVENT_ID, 'result', 'done', new Date(1200).toISOString()),
            );

            await stream.waitFor((p) => p.some((part) => part.event === 'end'));
            const events = eventParts(stream.parts);
            expect(events).toHaveLength(3);
            expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
            const end = endPart(stream.parts);
            expect(end).toEqual({ reason: 'success', terminalSeq: 2 });
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('live tail: events emitted after snapshot stream through with continuous seq', async () => {
        const boot = await bootListening(dir);
        try {
            boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
            const stream = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await stream.waitFor((p) => eventParts(p).length >= 1);
            await new Promise((r) => setTimeout(r, 20));

            boot.bus.emitObservability(llmRequest(ROOT_EVENT_ID, new Date(1100).toISOString()));
            boot.bus.emitObservability(
                outputEmitted(ROOT_EVENT_ID, 'result', 'done', new Date(1200).toISOString()),
            );

            await stream.waitFor((p) => p.some((part) => part.event === 'end'));
            const events = eventParts(stream.parts);
            expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
            expect(events.map((e) => e.kind)).toEqual([
                'dispatch',
                'observability',
                'observability',
            ]);
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('terminal `output.emitted` closes with reason=success', async () => {
        const boot = await bootListening(dir);
        try {
            boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
            const stream = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitObservability(
                outputEmitted(ROOT_EVENT_ID, 'result', 'ok', new Date(1200).toISOString()),
            );
            await stream.waitFor((p) => p.some((part) => part.event === 'end'));
            expect(endPart(stream.parts)?.reason).toBe('success');
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('terminal `chain.stopped` closes with reason=stopped', async () => {
        const boot = await bootListening(dir);
        try {
            boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
            const stream = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitObservability(chainStopped(ROOT_EVENT_ID, new Date(1200).toISOString()));
            await stream.waitFor((p) => p.some((part) => part.event === 'end'));
            expect(endPart(stream.parts)?.reason).toBe('stopped');
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('sub-ask dispatches with their own eventId do not terminate the parent stream', async () => {
        const boot = await bootListening(dir);
        try {
            boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
            const stream = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await new Promise((r) => setTimeout(r, 20));

            boot.bus.emitObservability(
                outputEmitted('evt-sub', 'result', 'sub done', new Date(1100).toISOString()),
            );
            boot.bus.emitObservability(llmRequest(ROOT_EVENT_ID, new Date(1150).toISOString()));
            await stream.waitFor((p) =>
                eventParts(p).some(
                    (e) =>
                        e.kind === 'observability' &&
                        (e.payload as ObservabilityEvent).type === 'llm.request',
                ),
            );
            expect(endPart(stream.parts)).toBeNull();

            boot.bus.emitObservability(
                outputEmitted(ROOT_EVENT_ID, 'result', 'real done', new Date(1200).toISOString()),
            );
            await stream.waitFor((p) => p.some((part) => part.event === 'end'));
            expect(endPart(stream.parts)?.reason).toBe('success');
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('client disconnect cleanly unsubscribes both bus listeners (no leak)', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await new Promise((r) => setTimeout(r, 30));

            stream.abort();
            await new Promise((r) => setTimeout(r, 80));

            boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
            boot.bus.emitObservability(
                outputEmitted(ROOT_EVENT_ID, 'result', 'late', new Date(1500).toISOString()),
            );

            const stream2 = await openStream(boot.port, boot.graphId, ROOT_EVENT_ID);
            await stream2.waitFor((p) => p.some((part) => part.event === 'end'));
            const events = eventParts(stream2.parts);
            expect(events.length).toBeGreaterThanOrEqual(2);
            const last = events[events.length - 1]!;
            expect((last.payload as ObservabilityEvent).type).toBe('output.emitted');
            stream2.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('returns 404 when the graph is not loaded', async () => {
        const boot = await bootListening(dir);
        try {
            const unloadedId = '11111111-1111-4111-8111-111111111111';
            const res = await fetch(
                `http://127.0.0.1:${boot.port}/api/graphs/${unloadedId}/dispatches/x/stream`,
                { headers: { 'x-fabritorio-token': boot.app.fabToken } },
            );
            expect(res.status).toBe(404);
            await res.text();
        } finally {
            await boot.cleanup();
        }
    });
});
