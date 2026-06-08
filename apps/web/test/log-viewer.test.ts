import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import { subscribeLogViewerStream } from '../components/LogViewer';
import {
    createRunnerClient,
    type DispatchStreamEvent,
    type ObservabilityReplayResult,
    type RunnerClient,
} from '../lib/runner-client';

function stubReplay(client: RunnerClient, result: ObservabilityReplayResult): void {
    (client as { observabilityReplay: RunnerClient['observabilityReplay'] }).observabilityReplay =
        async () => result;
}

async function tick(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

class FakeEventSource {
    static last: FakeEventSource | null = null;
    url: string;
    onmessage: ((ev: MessageEvent<string>) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    closed = false;
    constructor(url: string) {
        this.url = url;
        FakeEventSource.last = this;
    }
    close(): void {
        this.closed = true;
    }
    emitFrame(topic: string, payload: unknown): void {
        this.onmessage?.({ data: JSON.stringify({ topic, payload }) } as MessageEvent<string>);
    }
    emitObs(env: DispatchStreamEvent): void {
        this.emitFrame('observability', env);
    }
}

let baseCounter = 0;
function freshBase(): string {
    return `http://runner-lv-${baseCounter++}.test`;
}

beforeEach(() => {
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
        FakeEventSource;
    FakeEventSource.last = null;
});

afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

function dispatchEnv(eventId: string): DispatchStreamEvent {
    return {
        seq: 0,
        kind: 'dispatch',
        payload: {
            type: 'channel.received',
            ts: '2026-05-22T00:00:00.000Z',
            eventId,
            channelNodeId: 'c',
            source: 'webchat',
            messages: [],
        } as unknown as DispatchEvent,
    };
}

function obsEnv(seq: number, eventId: string): DispatchStreamEvent {
    return {
        seq,
        kind: 'observability',
        payload: {
            type: 'llm.chunk',
            ts: '2026-05-22T00:00:00.000Z',
            eventId,
            node_id: 'model-1',
            delta: 'x',
            kind: 'content',
        } as unknown as ObservabilityEvent,
    };
}

describe('subscribeLogViewerStream (multiplexed)', () => {
    it('opens the single /stream EventSource on mount', () => {
        const client = createRunnerClient(freshBase());
        stubReplay(client, { events: [], max: -1 });
        const base = client.baseUrl;
        const appendEvents = vi.fn();
        const clearEvents = vi.fn();

        const teardown = subscribeLogViewerStream({ client, appendEvents, clearEvents });

        expect(FakeEventSource.last?.url).toBe(`${base}/stream`);
        teardown();
    });

    it('clears the store on mount (fresh snapshot/live handshake)', () => {
        const client = createRunnerClient(freshBase());
        stubReplay(client, { events: [], max: -1 });
        const appendEvents = vi.fn();
        const clearEvents = vi.fn();

        const teardown = subscribeLogViewerStream({ client, appendEvents, clearEvents });

        expect(clearEvents).toHaveBeenCalledTimes(1);
        teardown();
    });

    it('appends arriving events in order (synchronous flush)', async () => {
        const client = createRunnerClient(freshBase());
        stubReplay(client, { events: [], max: -1 });
        const appendEvents =
            vi.fn<(evs: ReadonlyArray<DispatchEvent | ObservabilityEvent>) => void>();
        const clearEvents = vi.fn();

        const teardown = subscribeLogViewerStream({
            client,
            appendEvents,
            clearEvents,
            scheduleFlush: (flush) => flush(),
        });

        await tick();

        const a = dispatchEnv('d-1');
        const b = dispatchEnv('d-2');
        FakeEventSource.last!.emitObs({ ...a, seq: 1 });
        FakeEventSource.last!.emitObs({ ...b, seq: 2 });

        expect(appendEvents).toHaveBeenCalledTimes(2);
        expect(appendEvents.mock.calls[0]?.[0]).toEqual([a.payload]);
        expect(appendEvents.mock.calls[1]?.[0]).toEqual([b.payload]);
        teardown();
    });

    it('coalesces a burst into a single batched store write', async () => {
        const client = createRunnerClient(freshBase());
        stubReplay(client, { events: [], max: -1 });
        const appendEvents =
            vi.fn<(evs: ReadonlyArray<DispatchEvent | ObservabilityEvent>) => void>();
        const clearEvents = vi.fn();

        let scheduledFlush: (() => void) | null = null;
        const teardown = subscribeLogViewerStream({
            client,
            appendEvents,
            clearEvents,
            scheduleFlush: (flush) => {
                scheduledFlush = flush;
            },
        });

        await tick();

        const a = dispatchEnv('d-1');
        const b = dispatchEnv('d-2');
        const c = dispatchEnv('d-3');
        FakeEventSource.last!.emitObs({ ...a, seq: 1 });
        FakeEventSource.last!.emitObs({ ...b, seq: 2 });
        FakeEventSource.last!.emitObs({ ...c, seq: 3 });

        expect(appendEvents).not.toHaveBeenCalled();
        scheduledFlush!();
        expect(appendEvents).toHaveBeenCalledTimes(1);
        expect(appendEvents.mock.calls[0]?.[0]).toEqual([a.payload, b.payload, c.payload]);
        teardown();
    });

    it('closes the subscription and clears the store on unmount', () => {
        const client = createRunnerClient(freshBase());
        stubReplay(client, { events: [], max: -1 });
        const appendEvents = vi.fn();
        const clearEvents = vi.fn();

        const teardown = subscribeLogViewerStream({ client, appendEvents, clearEvents });
        clearEvents.mockClear();

        teardown();

        expect(clearEvents).toHaveBeenCalledTimes(1);
    });

    it('drops events that arrive after teardown (StrictMode double-mount race)', async () => {
        const client = createRunnerClient(freshBase());
        stubReplay(client, { events: [], max: -1 });
        const appendEvents =
            vi.fn<(evs: ReadonlyArray<DispatchEvent | ObservabilityEvent>) => void>();
        const clearEvents = vi.fn();

        const teardown = subscribeLogViewerStream({
            client,
            appendEvents,
            clearEvents,
            scheduleFlush: (flush) => flush(),
        });
        const source = FakeEventSource.last!;

        await tick();

        teardown();
        source.emitObs({ ...dispatchEnv('post-close'), seq: 9 });

        expect(appendEvents).not.toHaveBeenCalled();
    });

    it('seeds the store from the backfill (one batch, no glow) then publishes live past max', async () => {
        const client = createRunnerClient(freshBase());
        const appendEvents =
            vi.fn<(evs: ReadonlyArray<DispatchEvent | ObservabilityEvent>) => void>();
        const clearEvents = vi.fn();
        const publish = vi.fn<(e: ObservabilityEvent) => void>();

        stubReplay(client, {
            events: [obsEnv(0, 'd-1'), obsEnv(1, 'd-1'), obsEnv(2, 'd-1')],
            max: 2,
        });

        const teardown = subscribeLogViewerStream({
            client,
            appendEvents,
            clearEvents,
            publish,
            scheduleFlush: (flush) => flush(),
        });
        const src = FakeEventSource.last!;

        await tick();

        expect(appendEvents).toHaveBeenCalledTimes(1);
        expect(appendEvents.mock.calls[0]?.[0]).toHaveLength(3);
        expect(publish).not.toHaveBeenCalled();

        src.emitObs(obsEnv(3, 'd-1'));
        expect(publish).toHaveBeenCalledTimes(1);
        expect((publish.mock.calls[0]![0] as ObservabilityEvent).type).toBe('llm.chunk');

        appendEvents.mockClear();
        src.emitObs(obsEnv(2, 'd-1'));
        expect(publish).toHaveBeenCalledTimes(1);
        expect(appendEvents).not.toHaveBeenCalled();

        teardown();
    });

    it('uses the client provided — does not assume a global default', () => {
        const base = freshBase();
        const client: RunnerClient = createRunnerClient(base);
        stubReplay(client, { events: [], max: -1 });
        const appendEvents = vi.fn();
        const clearEvents = vi.fn();

        const teardown = subscribeLogViewerStream({ client, appendEvents, clearEvents });

        expect(FakeEventSource.last?.url).toBe(`${base}/stream`);
        teardown();
    });
});
