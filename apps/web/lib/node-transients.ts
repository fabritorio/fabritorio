import type { Graph, ObservabilityEvent } from '@fabritorio/types';
import { DispatchIndex } from './dispatch-index';

export interface NodeTransient {
    toolArgPreview?: string;
    toolExitOk?: boolean;
    routerTrying?: string;
    fellThroughReason?: string;
    stoppedReason?: string;
    iter?: { n: number; max?: number };
}

const GENERIC_STOP_REASON = 'stopped';

export class TransientReducer {
    private readonly nodeIds: ReadonlySet<string>;
    private readonly handlerIds: ReadonlyArray<string>;
    private readonly handlerMax: ReadonlyMap<string, number | undefined>;
    private readonly index: DispatchIndex;

    private readonly byOwner = new Map<string, NodeTransient>();
    private readonly iterByEventId = new Map<string, number>();
    private readonly liveEventIds = new Set<string>();

    constructor(graph: { nodes: ReadonlyArray<Graph['nodes'][number]> }) {
        this.nodeIds = new Set(graph.nodes.map((n) => n.id));
        const handlers = graph.nodes.filter((n) => n.type === 'handler');
        this.handlerIds = handlers.map((n) => n.id);
        this.handlerMax = new Map(
            handlers.map((n) => [
                n.id,
                typeof (n as { max_iterations?: unknown }).max_iterations === 'number'
                    ? (n as { max_iterations?: number }).max_iterations
                    : undefined,
            ]),
        );
        this.index = new DispatchIndex(graph);
    }

    private slot(nodeId: string): NodeTransient {
        let t = this.byOwner.get(nodeId);
        if (!t) {
            t = {};
            this.byOwner.set(nodeId, t);
        }
        return t;
    }

    ingest(event: ObservabilityEvent): void {
        this.index.ingest(event);

        const owner = this.index.resolveOwner(event);
        if (owner) this.liveEventIds.add(event.eventId);

        switch (event.type) {
            case 'tool.called': {
                if (!owner) break;
                this.slot(owner).toolArgPreview = formatToolTap(event.tool_name, event.args);
                delete this.slot(owner).toolExitOk;
                break;
            }
            case 'tool.result': {
                if (!owner) break;
                this.slot(owner).toolExitOk = event.exit_code === 0;
                break;
            }
            case 'model_router.attempted': {
                if (this.nodeIds.has(event.model_node_id)) {
                    const t = this.slot(event.model_node_id);
                    t.routerTrying = event.model_id;
                    delete t.fellThroughReason;
                }
                break;
            }
            case 'model_router.fell_through': {
                if (this.nodeIds.has(event.from_model_node_id)) {
                    const from = this.slot(event.from_model_node_id);
                    from.fellThroughReason = event.reason;
                    delete from.routerTrying;
                }
                if (this.nodeIds.has(event.to_model_node_id)) {
                    this.slot(event.to_model_node_id).routerTrying = event.to_model_id;
                }
                break;
            }
            case 'chain.stopped': {
                if (!owner) break;
                this.slot(owner).stoppedReason =
                    event.reason && event.reason.length > 0 ? event.reason : GENERIC_STOP_REASON;
                break;
            }
            case 'llm.request': {
                const n = (this.iterByEventId.get(event.eventId) ?? 0) + 1;
                this.iterByEventId.set(event.eventId, n);
                break;
            }
            case 'output.emitted':
            case 'llm.response':
                break;
            default:
                break;
        }
    }

    seedFromEvents(events: ReadonlyArray<ObservabilityEvent>): void {
        for (const ev of events) this.ingest(ev);
    }

    transientFor(nodeId: string): NodeTransient | null {
        const base = this.byOwner.get(nodeId);
        const iter = this.iterFor(nodeId);
        if (!base && !iter) return null;
        const out: NodeTransient = base ? { ...base } : {};
        if (iter) out.iter = iter;
        return out;
    }

    private iterFor(nodeId: string): NodeTransient['iter'] | undefined {
        if (this.handlerMax.has(nodeId)) {
            let n = 0;
            for (const eventId of this.liveEventIds) {
                n = Math.max(n, this.iterByEventId.get(eventId) ?? 0);
            }
            if (n === 0) return undefined;
            const max = this.handlerMax.get(nodeId);
            return max !== undefined ? { n, max } : { n };
        }
        for (const [eventId, count] of this.iterByEventId) {
            if (this.index.standInFor(eventId) === nodeId && count > 0) {
                return { n: count };
            }
        }
        return undefined;
    }
}

export function buildTransientReducer(
    graph: { nodes: ReadonlyArray<Graph['nodes'][number]> },
    events: ReadonlyArray<ObservabilityEvent>,
): TransientReducer {
    const r = new TransientReducer(graph);
    r.seedFromEvents(events);
    return r;
}

const MAX_PREVIEW = 48;

export function formatToolTap(toolName: string, args: Record<string, unknown>): string {
    const preview = argPreview(args);
    return preview ? `${toolName} ▸ ${preview}` : toolName;
}

export function argPreview(args: Record<string, unknown>): string {
    if (!args || typeof args !== 'object') return '';
    const preferred = ['command', 'cmd', 'query', 'path', 'file_path', 'url'];
    for (const key of preferred) {
        const v = args[key];
        if (typeof v === 'string' && v.length > 0) return truncate(v);
    }
    for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.length > 0) return truncate(v);
    }
    const keys = Object.keys(args);
    if (keys.length === 0) return '';
    try {
        return truncate(JSON.stringify(args));
    } catch {
        return '';
    }
}

function truncate(s: string): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW - 1)}…` : flat;
}
