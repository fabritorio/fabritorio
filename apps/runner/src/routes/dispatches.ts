import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import { isValidGraphId } from '../graphs/store.js';
import type { EventBus } from '../runtime/event-bus.js';
import type { GraphRuntimeRegistry } from '../runtime/graph-runtime.js';
import type { DispatchAbortRegistry } from '../runtime/dispatch-aborts.js';

export interface DispatchesRoutesDeps {
    runtimes: GraphRuntimeRegistry;
    bus: EventBus;
    dispatchAborts?: DispatchAbortRegistry;
}

interface StopParams {
    eventId: string;
}

interface StreamParams {
    id: string;
    eventId: string;
}

type AnyEvent = DispatchEvent | ObservabilityEvent;

interface WireEvent {
    seq: number;
    kind: 'dispatch' | 'observability';
    payload: AnyEvent;
}

interface EndPayload {
    reason: 'success' | 'stopped';
    terminalSeq: number;
}

function isObservability(event: AnyEvent): event is ObservabilityEvent {
    return 'type' in event;
}

function isTerminalObservability(event: ObservabilityEvent): boolean {
    return event.type === 'output.emitted' || event.type === 'chain.stopped';
}

export function registerDispatchesRoutes(app: FastifyInstance, deps: DispatchesRoutesDeps): void {
    app.get<{ Params: StreamParams }>(
        '/graphs/:id/dispatches/:eventId/stream',
        (req: FastifyRequest<{ Params: StreamParams }>, reply: FastifyReply) => {
            const { id, eventId: targetEventId } = req.params;
            if (!isValidGraphId(id)) {
                reply.code(400).send({ error: 'invalid id' });
                return reply;
            }
            const loaded = deps.runtimes.get(id);
            if (!loaded) {
                reply.code(404).send({ error: 'graph not loaded' });
                return reply;
            }

            const origin = req.headers.origin;
            reply.raw.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
                ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
            });
            reply.raw.write(':\n\n');

            let phase: 'buffering' | 'live' = 'buffering';
            const buffered: WireEvent[] = [];
            let snapshotMax = -1;
            let ended = false;

            const writeEvent = (env: WireEvent): void => {
                try {
                    reply.raw.write(`event: event\n`);
                    reply.raw.write(`data: ${JSON.stringify(env)}\n\n`);
                } catch {
                    // socket gone — `close` will tidy up
                }
            };

            const writeEnd = (payload: EndPayload): void => {
                try {
                    reply.raw.write(`event: end\n`);
                    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
                } catch {
                    // socket gone
                }
            };

            const handleIncoming = (env: WireEvent): void => {
                if (ended) return;
                if (phase === 'buffering') {
                    buffered.push(env);
                    return;
                }
                writeEvent(env);
                maybeTerminate(env);
            };

            const maybeTerminate = (env: WireEvent): void => {
                if (ended) return;
                if (env.kind !== 'observability') return;
                const ev = env.payload as ObservabilityEvent;
                if (ev.eventId !== targetEventId) return;
                if (!isTerminalObservability(ev)) return;
                const reason: EndPayload['reason'] =
                    ev.type === 'chain.stopped' ? 'stopped' : 'success';
                writeEnd({ reason, terminalSeq: env.seq });
                ended = true;
                close();
            };

            let nextLiveSeq = 0;

            const offDispatch = deps.bus.subscribeDispatch((ev) => {
                if (ev.eventId !== targetEventId) return;
                if (phase === 'live') {
                    handleIncoming({ seq: nextLiveSeq++, kind: 'dispatch', payload: ev });
                } else {
                    const list = deps.bus.eventsByDispatch(targetEventId);
                    const idx = list.indexOf(ev);
                    if (idx < 0) return;
                    handleIncoming({ seq: idx, kind: 'dispatch', payload: ev });
                }
            });

            const offObs = deps.bus.subscribeObservability((ev) => {
                if (ev.eventId !== targetEventId) return;
                if (phase === 'live') {
                    handleIncoming({ seq: nextLiveSeq++, kind: 'observability', payload: ev });
                } else {
                    const list = deps.bus.eventsByDispatch(targetEventId);
                    const idx = list.indexOf(ev);
                    if (idx < 0) return;
                    handleIncoming({ seq: idx, kind: 'observability', payload: ev });
                }
            });

            let listenersDetached = false;
            const close = () => {
                if (listenersDetached) return;
                listenersDetached = true;
                offDispatch();
                offObs();
                try {
                    reply.raw.end();
                } catch {
                    // already closed
                }
            };

            req.raw.on('close', close);
            req.raw.on('error', close);

            const snapshot = deps.bus.eventsByDispatch(targetEventId);
            for (let i = 0; i < snapshot.length; i++) {
                if (ended) break;
                const ev = snapshot[i]!;
                const env: WireEvent = {
                    seq: i,
                    kind: isObservability(ev) ? 'observability' : 'dispatch',
                    payload: ev,
                };
                writeEvent(env);
                maybeTerminate(env);
            }
            snapshotMax = snapshot.length - 1;
            nextLiveSeq = snapshot.length;

            if (!ended) {
                for (const env of buffered) {
                    if (env.seq <= snapshotMax) continue;
                    writeEvent(env);
                    maybeTerminate(env);
                    if (env.seq + 1 > nextLiveSeq) nextLiveSeq = env.seq + 1;
                    if (ended) break;
                }
            }
            buffered.length = 0;
            phase = 'live';

            return new Promise<void>((resolve) => {
                req.raw.on('close', () => resolve());
                req.raw.on('error', () => resolve());
                if (ended) {
                    resolve();
                }
            });
        },
    );

    app.post<{ Params: StopParams }>('/dispatches/:eventId/stop', (req, reply) => {
        const ok = deps.dispatchAborts?.abort(req.params.eventId) ?? false;
        return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: 'not running' });
    });
}
