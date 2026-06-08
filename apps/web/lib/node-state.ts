import type { Graph, ObservabilityEvent } from '@fabritorio/types';

export type NodeExecState = 'idle' | 'running' | 'waiting' | 'completed' | 'error';

export type NodeStateMap = Record<string, NodeExecState>;

export function computeNodeStates(
    graph: { nodes: ReadonlyArray<Graph['nodes'][number]> },
    events: ReadonlyArray<ObservabilityEvent>,
): NodeStateMap {
    const state: NodeStateMap = {};
    for (const n of graph.nodes) state[n.id] = 'idle';

    const dispatchReceiver = new Map<string, string>();

    for (const ev of events) {
        const id = ev.node_id;
        switch (ev.type) {
            case 'llm.request':
            case 'tool.called':
                if (id in state) state[id] = 'running';
                break;
            case 'llm.response':
            case 'tool.result':
                if (id in state) state[id] = 'completed';
                break;
            case 'gateway.received': {
                if (id in state) {
                    state[id] = 'running';
                    dispatchReceiver.set(ev.eventId, id);
                }
                const src = ev.source;
                const colon = src.indexOf(':');
                const channelId = colon >= 0 ? src.slice(colon + 1) : src;
                if (channelId in state) state[channelId] = 'completed';
                break;
            }
            case 'output.emitted': {
                if (id in state) state[id] = 'completed';
                const receiver = dispatchReceiver.get(ev.eventId);
                if (receiver && receiver in state) state[receiver] = 'completed';
                break;
            }
            case 'chain.stopped':
                if (id in state) state[id] = 'error';
                break;
            default:
                break;
        }
    }

    return state;
}

export function computeActiveEdges(
    graph: { edges: ReadonlyArray<Graph['edges'][number]> },
    states: NodeStateMap,
): Set<string> {
    const active = new Set<string>();
    for (const e of graph.edges) {
        const src = states[e.source.node_id];
        const tgt = states[e.target.node_id];
        if (src === 'completed' && tgt === 'running') {
            active.add(e.id);
        }
    }
    return active;
}
