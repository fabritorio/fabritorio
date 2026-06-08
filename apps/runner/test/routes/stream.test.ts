import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    DispatchEvent,
    EdgeTraversedEvent,
    Graph,
    LlmRequestEvent,
    ObservabilityEvent,
} from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import {
    createPermissionGateRegistry,
    type PermissionDecisionRequest,
    type PermissionGateHandle,
} from '../../src/runtime/permission.js';
import { inject } from '../helpers/inject.js';

const NODE_ID = 'agent-a';
const ROOT_EVENT_ID = 'evt-root-1';

let bootToken = '';

type BuiltServer = ReturnType<typeof buildServer>;

interface MuxFrame {
    topic: string;
    payload: unknown;
}

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

function traversed(edgeId: string): EdgeTraversedEvent {
    return {
        type: 'edge.traversed',
        graphId: 'g',
        edgeId,
        sourceNodeId: 'a',
        targetNodeId: 'b',
        direction: 'forward',
    } as unknown as EdgeTraversedEvent;
}

function singleNodeGraph(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'stream-mux',
        nodes: [
            {
                id: NODE_ID,
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 0, y: 0 },
            },
        ],
        edges: [],
    };
}

function fakeGate(
    graphId: string,
    nodeId: string,
): {
    handle: PermissionGateHandle;
    fire(req: PermissionDecisionRequest): void;
} {
    let pending: PermissionDecisionRequest[] = [];
    const subs = new Set<(req: PermissionDecisionRequest) => void>();
    const handle: PermissionGateHandle = {
        graphId,
        nodeId,
        async evaluate() {
            return 'allow';
        },
        pending: () => pending,
        decide: () => true,
        subscribe(listener) {
            subs.add(listener);
            return () => subs.delete(listener);
        },
        onTeardown: () => () => undefined,
        teardown: () => undefined,
    };
    return {
        handle,
        fire(req) {
            pending = [...pending, req];
            for (const s of subs) s(req);
        },
    };
}

interface BootResult {
    app: BuiltServer;
    bus: ReturnType<typeof createEventBus>;
    runtimes: ReturnType<typeof createGraphRuntimeRegistry>;
    permission: ReturnType<typeof createPermissionGateRegistry>;
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
    const permission = createPermissionGateRegistry();
    const app = buildServer({
        logger: false,
        graphStore,
        bus,
        runtimes,
        nodes,
        permissionGateRegistry: permission,
    });

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
    const port = Number.parseInt(new URL(address).port, 10);
    bootToken = app.fabToken;

    return {
        app,
        bus,
        runtimes,
        permission,
        graphId,
        port,
        async cleanup() {
            await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/unload` });
            await app.close();
        },
    };
}

interface StreamHandle {
    frames: MuxFrame[];
    waitFor(pred: (frames: MuxFrame[]) => boolean, timeoutMs?: number): Promise<void>;
    abort(): void;
}

async function openStream(port: number): Promise<StreamHandle> {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
        headers: { accept: 'text/event-stream', 'x-fabritorio-token': bootToken },
        signal: controller.signal,
    });
    if (!response.body) throw new Error('no response body');

    const frames: MuxFrame[] = [];
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
                    let dataRaw = '';
                    for (const line of frame.split('\n')) {
                        if (line.startsWith('data: ')) dataRaw += line.slice(6);
                    }
                    try {
                        frames.push(JSON.parse(dataRaw) as MuxFrame);
                    } catch {
                        // ignore non-JSON
                    }
                }
            }
        } catch {
            // aborted/closed — fine
        }
    })();

    const waitFor = async (pred: (frames: MuxFrame[]) => boolean, timeoutMs = 1500) => {
        const start = Date.now();
        while (!pred(frames)) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`timeout; got frames=${JSON.stringify(frames)}`);
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

    return { frames, waitFor, abort };
}

const obsFrames = (frames: MuxFrame[]): WireEnvelope[] =>
    frames.filter((f) => f.topic === 'observability').map((f) => f.payload as WireEnvelope);

describe('/stream (multiplexed firehose)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-stream-mux-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('observability: forward-only live fan-out — no snapshot replay, global seq tagging', async () => {
        const boot = await bootListening(dir);
        try {
            boot.bus.emitDispatch(dispatch(ROOT_EVENT_ID));
            boot.bus.emitObservability(llmRequest(ROOT_EVENT_ID, new Date(1100).toISOString()));

            const stream = await openStream(boot.port);
            await new Promise((r) => setTimeout(r, 60));

            expect(obsFrames(stream.frames)).toHaveLength(0);
            expect(
                stream.frames.some(
                    (fr) =>
                        fr.topic === 'observability' &&
                        (fr.payload as { snapshot?: boolean }).snapshot === true,
                ),
            ).toBe(false);

            boot.bus.emitObservability(llmRequest(ROOT_EVENT_ID, new Date(1200).toISOString()));
            await stream.waitFor((f) => obsFrames(f).length >= 1);

            boot.bus.emitDispatch(dispatch('evt-live-dispatch'));
            await stream.waitFor((f) => obsFrames(f).length >= 2);

            const events = obsFrames(stream.frames);
            expect(events.map((e) => e.seq)).toEqual([2, 3]);
            expect(events[0]!.kind).toBe('observability');
            expect((events[0]!.payload as ObservabilityEvent).type).toBe('llm.request');
            expect(events[1]!.kind).toBe('dispatch');
            expect((events[1]!.payload as DispatchEvent).eventId).toBe('evt-live-dispatch');
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('status: seeds + streams node-state for the loaded graph under status:<gid>', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openStream(boot.port);
            await stream.waitFor((f) => f.some((fr) => fr.topic === `status:${boot.graphId}`));
            const seed = stream.frames.find((fr) => fr.topic === `status:${boot.graphId}`);
            expect((seed!.payload as { running: unknown[] }).running).toEqual([]);

            boot.bus.emitObservability({
                type: 'gateway.received',
                ts: new Date(1300).toISOString(),
                eventId: 'd-live',
                node_id: NODE_ID,
            } as unknown as ObservabilityEvent);
            await stream.waitFor(
                (f) =>
                    f.filter((fr) => fr.topic === `status:${boot.graphId}`).length >= 2 &&
                    (
                        f.filter((fr) => fr.topic === `status:${boot.graphId}`).at(-1)!.payload as {
                            running: unknown[];
                        }
                    ).running.length === 1,
            );
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('permission: seeds pending + streams new requests under permission:<gid>:<nid>', async () => {
        const boot = await bootListening(dir);
        const gate = fakeGate(boot.graphId, 'perm-1');
        gate.fire({
            permissionNodeId: 'perm-1',
            callId: 'c-seed',
            toolName: 'bash',
            args: {},
            ts: 't0',
        });
        boot.permission.register(gate.handle);
        try {
            const stream = await openStream(boot.port);
            const topic = `permission:${boot.graphId}:perm-1`;
            await stream.waitFor((f) =>
                f.some(
                    (fr) =>
                        fr.topic === topic &&
                        (fr.payload as PermissionDecisionRequest).callId === 'c-seed',
                ),
            );

            gate.fire({
                permissionNodeId: 'perm-1',
                callId: 'c-live',
                toolName: 'bash',
                args: {},
                ts: 't1',
            });
            await stream.waitFor((f) =>
                f.some(
                    (fr) =>
                        fr.topic === topic &&
                        (fr.payload as PermissionDecisionRequest).callId === 'c-live',
                ),
            );
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });

    it('animation: streams edge.traversed live under the animation topic (no seed)', async () => {
        const boot = await bootListening(dir);
        try {
            const stream = await openStream(boot.port);
            await new Promise((r) => setTimeout(r, 30));
            boot.bus.emitTraversal(traversed('e-1'));
            await stream.waitFor((f) => f.some((fr) => fr.topic === 'animation'));
            const anim = stream.frames.find((fr) => fr.topic === 'animation');
            expect((anim!.payload as EdgeTraversedEvent).edgeId).toBe('e-1');
            stream.abort();
        } finally {
            await boot.cleanup();
        }
    });
});
