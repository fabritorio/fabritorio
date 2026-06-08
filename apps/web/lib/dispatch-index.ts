import type { Graph, ObservabilityEvent } from '@fabritorio/types';
import { phaseOf } from './event-phase';

export class DispatchIndex {
    private readonly nodeIds: ReadonlySet<string>;
    private readonly standIn = new Map<string, string>();
    private readonly phase = new Map<string, string>();

    constructor(graph: { nodes: ReadonlyArray<Graph['nodes'][number]> }) {
        this.nodeIds = new Set(graph.nodes.map((n) => n.id));
    }

    resolveOwner(event: ObservabilityEvent): string | null {
        if (this.nodeIds.has(event.node_id)) return event.node_id;
        const standIn = this.standIn.get(event.eventId);
        if (standIn && this.nodeIds.has(standIn)) return standIn;
        return null;
    }

    ingest(event: ObservabilityEvent): void {
        if (event.type === 'gateway.received') {
            if (this.nodeIds.has(event.node_id)) {
                this.standIn.set(event.eventId, event.node_id);
            }
        }

        const owner = this.resolveOwner(event);
        if (!owner) return;

        const next = phaseOf(event);
        if (next === null) {
            this.phase.delete(owner);
        } else {
            this.phase.set(owner, next);
        }
    }

    seedFromEvents(events: ReadonlyArray<ObservabilityEvent>): void {
        for (const ev of events) this.ingest(ev);
    }

    phaseFor(nodeId: string): string | null {
        return this.phase.get(nodeId) ?? null;
    }

    standInFor(eventId: string): string | null {
        return this.standIn.get(eventId) ?? null;
    }
}

export function buildDispatchIndex(
    graph: { nodes: ReadonlyArray<Graph['nodes'][number]> },
    events: ReadonlyArray<ObservabilityEvent>,
): DispatchIndex {
    const index = new DispatchIndex(graph);
    index.seedFromEvents(events);
    return index;
}
