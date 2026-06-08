import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import type { EventBus } from '../runtime/event-bus.js';

export interface ObservabilityRoutesDeps {
    bus: EventBus;
}

type AnyEvent = DispatchEvent | ObservabilityEvent;

interface WireEvent {
    seq: number;
    kind: 'dispatch' | 'observability';
    payload: AnyEvent;
}

const SNAPSHOT_TAIL_CAP = 500;
const SNAPSHOT_BYTE_CAP = 8 * 1024 * 1024;
const SNAPSHOT_ANCESTOR_LOOKBACK = 2000;

function isObservability(event: AnyEvent): event is ObservabilityEvent {
    return 'type' in event;
}

function collectAncestorsBounded(
    full: ReadonlyArray<AnyEvent>,
    startIdx: number,
    lookback: number,
): Array<{ idx: number; ev: AnyEvent }> {
    const needed = new Set<string>();
    for (let i = startIdx; i < full.length; i++) {
        const ev = full[i]!;
        needed.add(ev.eventId);
        if (!isObservability(ev) && ev.parentId) needed.add(ev.parentId);
    }
    const scanFrom = Math.max(0, startIdx - lookback);
    const prepend: Array<{ idx: number; ev: AnyEvent }> = [];
    for (let i = scanFrom; i < startIdx; i++) {
        const ev = full[i]!;
        if (isObservability(ev)) continue;
        if (!needed.has(ev.eventId)) continue;
        prepend.push({ idx: i, ev });
        if (ev.parentId) needed.add(ev.parentId);
    }
    return prepend;
}

export function registerObservabilityRoutes(
    app: FastifyInstance,
    deps: ObservabilityRoutesDeps,
): void {
    app.get('/observability/replay', (req: FastifyRequest, reply: FastifyReply) => {
        const query = req.query as { tail?: string; before?: string; limit?: string };
        const parsedTail = Number.parseInt(query.tail ?? '', 10);
        const tailCap =
            Number.isFinite(parsedTail) && parsedTail > 0 ? parsedTail : SNAPSHOT_TAIL_CAP;

        const full = deps.bus.allEvents();

        const tail: WireEvent[] = [];
        let bytes = 0;
        let windowStart = full.length;
        for (let i = full.length - 1; i >= 0 && tail.length < tailCap; i--) {
            const ev = full[i]!;
            const env: WireEvent = {
                seq: i,
                kind: isObservability(ev) ? 'observability' : 'dispatch',
                payload: ev,
            };
            const size = JSON.stringify(env).length;
            if (tail.length > 0 && bytes + size > SNAPSHOT_BYTE_CAP) break;
            bytes += size;
            tail.push(env);
            windowStart = i;
        }
        tail.reverse();

        const events: WireEvent[] = [];
        for (const { idx, ev } of collectAncestorsBounded(
            full,
            windowStart,
            SNAPSHOT_ANCESTOR_LOOKBACK,
        )) {
            events.push({
                seq: idx,
                kind: isObservability(ev) ? 'observability' : 'dispatch',
                payload: ev,
            });
        }
        for (const env of tail) events.push(env);

        return reply.send({ events, max: full.length - 1 });
    });
}
