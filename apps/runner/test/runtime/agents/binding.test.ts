import { describe, it, expect } from 'vitest';
import type { DispatchEvent, Edge, Graph, ObservabilityEvent } from '@fabritorio/types';
import { createAgentBinding } from '../../../src/runtime/agents/binding.js';
import type { Agent, AgentDispatchCtx, AgentReply } from '../../../src/runtime/agents/agent.js';
import type { NodeContext } from '../../../src/runtime/graph-runtime.js';
import { createEventBus } from '../../../src/runtime/event-bus.js';

const GRAPH_ID = 'graph-1';
const AGENT_ID = 'ag';
const OUTPUT_NODE_ID = 'l1-output';

class FakeAgent implements Agent {
    readonly outputNodeId = OUTPUT_NODE_ID;
    constructor(private readonly fn: (inbound: DispatchEvent) => Promise<AgentReply>) {}
    dispatch(inbound: DispatchEvent, _ctx: AgentDispatchCtx): Promise<AgentReply> {
        return this.fn(inbound);
    }
}

function l2Graph(): Graph {
    return {
        id: GRAPH_ID,
        kind: 'l2',
        nodes: [
            { id: 'ch', type: 'channel', channel_kind: 'webchat', position: { x: 0, y: 0 } },
            { id: AGENT_ID, type: 'native_agent', l1_graph_id: 'x', position: { x: 1, y: 0 } },
        ],
        edges: [
            {
                id: 'ag->ch',
                source: { node_id: AGENT_ID, port_id: 'out' },
                target: { node_id: 'ch', port_id: 'in' },
            },
        ],
    };
}

function ctxFor(graph: Graph, bus: ReturnType<typeof createEventBus>): NodeContext {
    const node = graph.nodes.find((n) => n.id === AGENT_ID)!;
    const outgoing = graph.edges.filter((e) => e.source.node_id === AGENT_ID);
    return {
        graph,
        node,
        bus,
        outgoing,
        incoming: [],
        topicFor: (edge: Edge) => edge.id,
    };
}

async function makeReceiver(
    bus: ReturnType<typeof createEventBus>,
    agentFn: ((inbound: DispatchEvent) => Promise<AgentReply>) | 'no-build',
) {
    const graph = l2Graph();
    const binding = createAgentBinding({
        nodeType: 'native_agent',
        isReferenceEdge: () => false,
        async build() {
            if (agentFn === 'no-build') throw new Error('build skipped');
            return new FakeAgent(agentFn);
        },
    });
    const ctx = ctxFor(graph, bus);
    if (agentFn !== 'no-build') {
        await binding.activate!(ctx);
    }
    const edge = graph.edges[0]!;
    const receiver = binding.receiver!(ctx, edge);
    return { receiver: receiver!, edge };
}

function obsOf(bus: ReturnType<typeof createEventBus>): ObservabilityEvent[] {
    return bus.allEvents().filter((e): e is ObservabilityEvent => 'type' in e);
}

const inbound: DispatchEvent = {
    eventId: 'ev-1',
    source: 'ask:caller->ag:ev-1',
    timestamp: 0,
    messages: [{ role: 'user', content: 'hi' }],
};

describe('createAgentBinding terminal guarantee', () => {
    it('agent.dispatch throw → still emits output.emitted (errored) and no chain.stopped', async () => {
        const bus = createEventBus();
        const { receiver } = await makeReceiver(bus, async () => {
            throw new Error('boom in dispatch');
        });
        await receiver(inbound);

        const obs = obsOf(bus);
        const gw = obs.filter((e) => e.type === 'gateway.received');
        const out = obs.filter((e) => e.type === 'output.emitted');
        const stopped = obs.filter((e) => e.type === 'chain.stopped');
        expect(gw).toHaveLength(1);
        expect(out).toHaveLength(1);
        expect((out[0] as { port: string }).port).toBe('error');
        expect(stopped).toHaveLength(0);
    });

    it('throw AFTER output.emitted (in child fan-out) does NOT double-emit a terminal', async () => {
        const bus = createEventBus();
        const realPublish = bus.publish.bind(bus);
        bus.publish = async () => {
            throw new Error('publish exploded');
        };
        const { receiver } = await makeReceiver(bus, async () => ({
            output: { role: 'assistant', content: 'ok' },
            errored: false,
        }));
        await expect(receiver(inbound)).rejects.toThrow(/publish exploded/);
        bus.publish = realPublish;

        const obs = obsOf(bus);
        const out = obs.filter((e) => e.type === 'output.emitted');
        const stopped = obs.filter((e) => e.type === 'chain.stopped');
        expect(out).toHaveLength(1);
        expect(stopped).toHaveLength(0);
    });

    it('silent-drop path (agent not activated) emits a chain.stopped so the caller ask clears', async () => {
        const bus = createEventBus();
        const { receiver } = await makeReceiver(bus, 'no-build');
        await receiver(inbound);

        const obs = obsOf(bus);
        const gw = obs.filter((e) => e.type === 'gateway.received');
        const stopped = obs.filter((e) => e.type === 'chain.stopped');
        expect(gw).toHaveLength(0);
        expect(stopped).toHaveLength(1);
        expect(stopped[0]!.eventId).toBe('ev-1');
        expect((stopped[0] as { reason?: string }).reason).toMatch(/not activated/);
    });

    it('stopped reply stamps meta.stopped on the emitted reply dispatch (durable rendering)', async () => {
        const bus = createEventBus();
        const replies: DispatchEvent[] = [];
        bus.subscribeDispatch((d) => {
            if (d.parentId === inbound.eventId) replies.push(d);
        });
        const { receiver } = await makeReceiver(bus, async () => ({
            output: { role: 'assistant', content: 'partial…' },
            errored: false,
            stopped: true,
        }));
        await receiver(inbound);

        expect(replies).toHaveLength(1);
        expect(replies[0]!.meta?.stopped).toBe(true);
        expect(replies[0]!.meta?.port).toBe('result');
    });

    it('a non-stopped reply does NOT stamp meta.stopped', async () => {
        const bus = createEventBus();
        const replies: DispatchEvent[] = [];
        bus.subscribeDispatch((d) => {
            if (d.parentId === inbound.eventId) replies.push(d);
        });
        const { receiver } = await makeReceiver(bus, async () => ({
            output: { role: 'assistant', content: 'done' },
            errored: false,
        }));
        await receiver(inbound);

        expect(replies).toHaveLength(1);
        expect(replies[0]!.meta?.stopped).toBeUndefined();
    });

    it('normal success → exactly one terminal (output.emitted), no spurious chain.stopped', async () => {
        const bus = createEventBus();
        const { receiver } = await makeReceiver(bus, async () => ({
            output: { role: 'assistant', content: 'done' },
            errored: false,
        }));
        await receiver(inbound);

        const obs = obsOf(bus);
        const gw = obs.filter((e) => e.type === 'gateway.received');
        const out = obs.filter((e) => e.type === 'output.emitted');
        const stopped = obs.filter((e) => e.type === 'chain.stopped');
        expect(gw).toHaveLength(1);
        expect(out).toHaveLength(1);
        expect((out[0] as { port: string }).port).toBe('result');
        expect(stopped).toHaveLength(0);
    });
});
