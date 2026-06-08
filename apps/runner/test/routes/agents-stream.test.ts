import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    ChainStoppedEvent,
    DispatchEvent,
    Graph,
    OutputEmittedEvent,
} from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { inject } from '../helpers/inject.js';

const CALLER_ID = 'agent-caller';
const CALLEE_ID = 'agent-callee';
const CHANNEL_ID = 'ch';

let bootToken = '';

type BuiltServer = ReturnType<typeof buildServer>;

interface SsePart {
    event: string;
    data: unknown;
}

function graphWithAgents(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'agent-asks-stream',
        nodes: [
            {
                id: CALLER_ID,
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 0, y: 0 },
            },
            {
                id: CALLEE_ID,
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000001',
                position: { x: 200, y: 0 },
            },
            {
                id: CHANNEL_ID,
                type: 'channel',
                channel_kind: 'webchat',
                position: { x: 400, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-caller-callee',
                source: { node_id: CALLER_ID, port_id: 'out' },
                target: { node_id: CALLEE_ID, port_id: 'in' },
            },
        ],
    };
}

function askOutbound(
    eventId: string,
    callerId: string,
    calleeId: string,
    askCallId: string,
    timestamp: number,
    brief = 'do the thing',
    extraMeta: Record<string, unknown> = {},
): DispatchEvent {
    return {
        eventId,
        source: `ask:${callerId}->${calleeId}:${eventId}`,
        timestamp,
        messages: [{ role: 'user', content: brief }],
        meta: {
            ask_call_id: askCallId,
            ask_chain: [callerId],
            ask_caller_node_id: callerId,
            ask_callee_node_id: calleeId,
            ...extraMeta,
        },
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
        node_id: 'output-x',
        port,
        port_id: port,
        messages: [{ role: 'assistant', content }],
    };
}

function chainStopped(eventId: string, ts: string, reason?: string): ChainStoppedEvent {
    return {
        type: 'chain.stopped',
        ts,
        eventId,
        parentId: eventId,
        node_id: 'callee-x',
        ...(reason !== undefined ? { reason } : {}),
    };
}

interface BootResult {
    app: BuiltServer;
    bus: ReturnType<typeof createEventBus>;
    runtimes: ReturnType<typeof createGraphRuntimeRegistry>;
    graphStore: ReturnType<typeof createGraphStore>;
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
        payload: graphWithAgents(),
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
        graphStore,
        graphId,
        port,
        async cleanup() {
            await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/unload` });
            await app.close();
        },
    };
}

async function openAsksStream(
    port: number,
    graphId: string,
): Promise<{
    parts: SsePart[];
    waitFor(pred: (parts: SsePart[]) => boolean, timeoutMs?: number): Promise<void>;
    abort(): void;
    response: Response;
}> {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/graphs/${graphId}/asks/stream`, {
        headers: { accept: 'text/event-stream', 'x-fabritorio-token': bootToken },
        signal: controller.signal,
    });
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

describe('/graphs/:id/asks/stream', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-asks-sse-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('emits `started` for a new outbound ask (meta.port absent)', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitDispatch(
                askOutbound('e-start', CALLER_ID, CALLEE_ID, 'ask-1', 1000, 'hi callee'),
            );
            await stream.waitFor((p) => p.some((part) => part.event === 'started'));
            const startedPart = stream.parts.find((p) => p.event === 'started')!;
            expect(startedPart.data).toMatchObject({
                eventId: 'e-start',
                askCallId: 'ask-1',
                callerNodeId: CALLER_ID,
                calleeNodeId: CALLEE_ID,
                brief: 'hi callee',
                startedAt: 1000,
            });
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('reply Dispatches (meta.port set) do NOT emit `started`', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitDispatch(
                askOutbound('e-reply', CALLER_ID, CALLEE_ID, 'ask-2', 2000, 'reply payload', {
                    port: 'result',
                }),
            );
            await new Promise((r) => setTimeout(r, 50));
            expect(stream.parts.some((p) => p.event === 'started')).toBe(false);
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('emits `completed` with durationMs and resultSnippet for a matching output.emitted', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitDispatch(
                askOutbound('e-ok', CALLER_ID, CALLEE_ID, 'ask-ok', 5000, 'do work'),
            );
            boot.bus.emitObservability(
                outputEmitted('e-ok', 'result', 'all done here', new Date(5750).toISOString()),
            );
            await stream.waitFor((p) => p.some((part) => part.event === 'completed'));
            const completed = stream.parts.find((p) => p.event === 'completed')!;
            expect(completed.data).toMatchObject({
                eventId: 'e-ok',
                askCallId: 'ask-ok',
                status: 'ok',
                durationMs: 750,
                resultSnippet: 'all done here',
            });
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('emits `completed` with status failed for a chain.stopped terminal', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitDispatch(
                askOutbound('e-stop', CALLER_ID, CALLEE_ID, 'ask-stop', 5000, 'do work'),
            );
            boot.bus.emitObservability(
                chainStopped('e-stop', new Date(5600).toISOString(), 'agent not activated'),
            );
            await stream.waitFor((p) => p.some((part) => part.event === 'completed'));
            const completed = stream.parts.find((p) => p.event === 'completed')!;
            expect(completed.data).toMatchObject({
                eventId: 'e-stop',
                askCallId: 'ask-stop',
                status: 'failed',
                durationMs: 600,
                resultSnippet: 'agent not activated',
            });
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('mid-flight subscribe: completion for an ask started before subscribe still arrives', async () => {
        const boot = await bootListening(dir);
        try {
            boot.bus.emitDispatch(
                askOutbound('e-pre', CALLER_ID, CALLEE_ID, 'ask-pre', 7000, 'pre-subscribe'),
            );
            const stream = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitObservability(
                outputEmitted('e-pre', 'result', 'late reply', new Date(7400).toISOString()),
            );
            await stream.waitFor((p) => p.some((part) => part.event === 'completed'));
            const completed = stream.parts.find((p) => p.event === 'completed')!;
            expect(completed.data).toMatchObject({
                eventId: 'e-pre',
                askCallId: 'ask-pre',
                status: 'ok',
                durationMs: 400,
                resultSnippet: 'late reply',
            });
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('asks in graph X do not bleed into the stream for graph Y', async () => {
        const boot = await bootListening(dir);
        try {
            const otherCallerId = 'agent-caller-other';
            const otherCalleeId = 'agent-callee-other';
            const otherGraph: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
                kind: 'l2',
                name: 'other-graph',
                nodes: [
                    {
                        id: otherCallerId,
                        type: 'native_agent',
                        l1_graph_id: '00000000-0000-4000-8000-000000000002',
                        position: { x: 0, y: 0 },
                    },
                    {
                        id: otherCalleeId,
                        type: 'native_agent',
                        l1_graph_id: '00000000-0000-4000-8000-000000000003',
                        position: { x: 200, y: 0 },
                    },
                    {
                        id: 'ch-other',
                        type: 'channel',
                        channel_kind: 'webchat',
                        position: { x: 400, y: 0 },
                    },
                ],
                edges: [],
            };
            const otherRes = await inject(boot.app, {
                method: 'POST',
                url: '/api/graphs',
                payload: otherGraph,
            });
            const otherId = (otherRes.json() as { graph: Graph }).graph.id!;
            await inject(boot.app, { method: 'POST', url: `/api/graphs/${otherId}/load` });

            const stream = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 20));

            boot.bus.emitDispatch(
                askOutbound('e-bleed', otherCallerId, otherCalleeId, 'ask-other', 8000, 'cross'),
            );
            boot.bus.emitDispatch(
                askOutbound('e-same', CALLER_ID, CALLEE_ID, 'ask-same', 8500, 'same'),
            );

            await stream.waitFor((p) => p.some((part) => part.event === 'started'));
            const startedEvents = stream.parts.filter((p) => p.event === 'started');
            expect(startedEvents).toHaveLength(1);
            expect((startedEvents[0]!.data as { eventId: string }).eventId).toBe('e-same');
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('client disconnect unsubscribes both bus listeners', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 30));

            stream.abort();
            await new Promise((r) => setTimeout(r, 50));

            const stream2 = await openAsksStream(boot.port, boot.graphId);
            await new Promise((r) => setTimeout(r, 20));
            boot.bus.emitDispatch(
                askOutbound('e-after', CALLER_ID, CALLEE_ID, 'ask-after', 9000, 'fresh'),
            );
            await stream2.waitFor((p) => p.some((part) => part.event === 'started'));
            const got = stream2.parts.filter((p) => p.event === 'started');
            expect(got).toHaveLength(1);
            stream2.abort();
        } finally {
            await boot.cleanup();
        }
    });
});
