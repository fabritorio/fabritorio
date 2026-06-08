import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    AskCallDetail,
    AskCallSummary,
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

function graphWithAgents(): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'agent-calls',
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

interface BootResult {
    app: ReturnType<typeof buildServer>;
    bus: ReturnType<typeof createEventBus>;
    graphId: string;
    cleanup(): Promise<void>;
}

async function bootWithLoadedGraph(dir: string): Promise<BootResult> {
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
    const load = await inject(app, {
        method: 'POST',
        url: `/api/graphs/${graphId}/load`,
    });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }

    return {
        app,
        bus,
        graphId,
        async cleanup() {
            await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/unload` });
            await app.close();
        },
    };
}

function askOutbound(
    eventId: string,
    callerId: string,
    calleeId: string,
    askCallId: string,
    timestamp: number,
    brief = 'do the thing',
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

describe('agent calls routes', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-agents-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('GET /calls returns asks issued by the node, newest-first', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(askOutbound('e1', CALLER_ID, CALLEE_ID, 'a1', 1000));
            boot.bus.emitObservability(
                outputEmitted('e1', 'result', 'reply 1', new Date(1500).toISOString()),
            );
            boot.bus.emitDispatch(askOutbound('e2', CALLER_ID, CALLEE_ID, 'a2', 2000));
            boot.bus.emitObservability(
                outputEmitted('e2', 'result', 'reply 2', new Date(2300).toISOString()),
            );
            boot.bus.emitDispatch(askOutbound('e3', CALLER_ID, CALLEE_ID, 'a3', 3000));
            boot.bus.emitObservability(
                outputEmitted('e3', 'result', 'reply 3', new Date(3700).toISOString()),
            );

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls`,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { callerNodeId: string; calls: AskCallSummary[] };
            expect(body.callerNodeId).toBe(CALLER_ID);
            expect(body.calls.map((c) => c.eventId)).toEqual(['e3', 'e2', 'e1']);
            expect(body.calls[0]!.status).toBe('ok');
            expect(body.calls[0]!.durationMs).toBe(700);
            expect(body.calls[0]!.calleeNodeId).toBe(CALLEE_ID);
            expect(body.calls[0]!.askCallId).toBe('a3');
            expect(body.calls[0]!.briefSnippet).toBe('do the thing');
            expect(body.calls[0]!.resultSnippet).toBe('reply 3');
        } finally {
            await boot.cleanup();
        }
    });

    it('GET /calls returns 0 entries for a node that has issued no asks', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls`,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { calls: AskCallSummary[] };
            expect(body.calls).toEqual([]);
        } finally {
            await boot.cleanup();
        }
    });

    it('a mid-flight call reports status: running and null durationMs', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(askOutbound('e-pending', CALLER_ID, CALLEE_ID, 'a-pend', 1000));

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls`,
            });
            const body = res.json() as { calls: AskCallSummary[] };
            expect(body.calls).toHaveLength(1);
            expect(body.calls[0]!.status).toBe('running');
            expect(body.calls[0]!.durationMs).toBeNull();
            expect(body.calls[0]!.resultSnippet).toBeNull();
        } finally {
            await boot.cleanup();
        }
    });

    it('a completed call reports status: ok and a non-null durationMs', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(askOutbound('e-ok', CALLER_ID, CALLEE_ID, 'a-ok', 5000));
            boot.bus.emitObservability(
                outputEmitted('e-ok', 'result', 'done', new Date(6200).toISOString()),
            );

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls`,
            });
            const body = res.json() as { calls: AskCallSummary[] };
            expect(body.calls[0]!.status).toBe('ok');
            expect(body.calls[0]!.durationMs).toBe(1200);
        } finally {
            await boot.cleanup();
        }
    });

    it('GET /calls/:eventId returns the call/response/internal trio', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(
                askOutbound('e-detail', CALLER_ID, CALLEE_ID, 'a-d', 1000, 'help'),
            );
            boot.bus.emitObservability(
                outputEmitted('e-detail', 'result', 'sure', new Date(1400).toISOString()),
            );

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls/e-detail`,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as AskCallDetail;
            expect(body.call.brief).toBe('help');
            expect(body.call.callerNodeId).toBe(CALLER_ID);
            expect(body.call.calleeNodeId).toBe(CALLEE_ID);
            expect(body.call.askChain).toEqual([CALLER_ID]);
            expect(body.response.status).toBe('ok');
            expect(body.response.stdout).toBe('sure');
            expect(body.response.exitCode).toBe(0);
            expect(body.response.durationMs).toBe(400);
            expect(body.internal.length).toBeGreaterThan(0);
        } finally {
            await boot.cleanup();
        }
    });

    it('failed output (port=error) surfaces as status: failed, exitCode: 1', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(askOutbound('e-err', CALLER_ID, CALLEE_ID, 'a-err', 1000));
            boot.bus.emitObservability(
                outputEmitted('e-err', 'error', 'boom', new Date(1100).toISOString()),
            );

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls/e-err`,
            });
            const body = res.json() as AskCallDetail;
            expect(body.response.status).toBe('failed');
            expect(body.response.exitCode).toBe(1);
        } finally {
            await boot.cleanup();
        }
    });

    it('a chain.stopped terminal surfaces in /calls as failed with reason snippet and durationMs', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(askOutbound('e-stop', CALLER_ID, CALLEE_ID, 'a-stop', 1000));
            boot.bus.emitObservability(
                chainStopped('e-stop', new Date(1900).toISOString(), 'agent not activated'),
            );

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls`,
            });
            const body = res.json() as { calls: AskCallSummary[] };
            expect(body.calls).toHaveLength(1);
            expect(body.calls[0]!.status).toBe('failed');
            expect(body.calls[0]!.durationMs).toBe(900);
            expect(body.calls[0]!.resultSnippet).toBe('agent not activated');
        } finally {
            await boot.cleanup();
        }
    });

    it('a chain.stopped with no reason falls back to a default snippet', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(askOutbound('e-stop2', CALLER_ID, CALLEE_ID, 'a-stop2', 1000));
            boot.bus.emitObservability(chainStopped('e-stop2', new Date(1100).toISOString()));

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls`,
            });
            const body = res.json() as { calls: AskCallSummary[] };
            expect(body.calls[0]!.status).toBe('failed');
            expect(body.calls[0]!.resultSnippet).toBe('chain stopped');
        } finally {
            await boot.cleanup();
        }
    });

    it('GET /calls/:eventId reports failed/exitCode 1 for a chain.stopped-terminated ask', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            boot.bus.emitDispatch(
                askOutbound('e-stop-detail', CALLER_ID, CALLEE_ID, 'a-sd', 1000, 'help'),
            );
            boot.bus.emitObservability(
                chainStopped('e-stop-detail', new Date(1500).toISOString(), 'cancelled'),
            );

            const res = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls/e-stop-detail`,
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as AskCallDetail;
            expect(body.response.status).toBe('failed');
            expect(body.response.exitCode).toBe(1);
            expect(body.response.stdout).toBe('cancelled');
            expect(body.response.durationMs).toBe(500);
        } finally {
            await boot.cleanup();
        }
    });

    it('404s on unknown graph or unknown eventId, and on event not belonging to this caller', async () => {
        const boot = await bootWithLoadedGraph(dir);
        try {
            const ghostGraph = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/00000000-0000-4000-8000-deadbeefdead/${CALLER_ID}/calls`,
            });
            expect(ghostGraph.statusCode).toBe(404);

            const ghostNode = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/no-such-node/calls`,
            });
            expect(ghostNode.statusCode).toBe(404);

            const missingEvent = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls/never-emitted`,
            });
            expect(missingEvent.statusCode).toBe(404);

            boot.bus.emitDispatch(askOutbound('e-other', CALLEE_ID, CALLER_ID, 'a-x', 1000));
            const wrongCaller = await inject(boot.app, {
                method: 'GET',
                url: `/api/agents/${boot.graphId}/${CALLER_ID}/calls/e-other`,
            });
            expect(wrongCaller.statusCode).toBe(404);
        } finally {
            await boot.cleanup();
        }
    });
});
