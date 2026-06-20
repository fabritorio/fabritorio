import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunnerClient, type DispatchStreamEvent } from '../lib/runner-client';

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
    emitRaw(data: string): void {
        this.onmessage?.({ data } as MessageEvent<string>);
    }
    fireError(): void {
        this.onerror?.(new Event('error'));
    }
}

let baseCounter = 0;
function freshBase(): string {
    return `http://runner-${baseCounter++}.test`;
}

beforeEach(() => {
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
        FakeEventSource;
    FakeEventSource.last = null;
});

afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe('runnerClient.observabilityStream (multiplexed)', () => {
    it('opens the single /stream URL on the configured base', () => {
        const client = createRunnerClient(freshBase());
        const base = client.baseUrl;
        client.observabilityStream({ event: () => {} });
        expect(FakeEventSource.last?.url).toBe(`${base}/stream`);
    });

    it('dispatches observability-topic envelopes to onEvent', () => {
        const client = createRunnerClient(freshBase());
        const onEvent = vi.fn();
        client.observabilityStream({ event: onEvent });

        const env: DispatchStreamEvent = {
            seq: 0,
            kind: 'dispatch',
            payload: {
                type: 'channel.received',
                ts: '2026-05-22T00:00:00.000Z',
                eventId: 'd-1',
                channelNodeId: 'c',
                source: 'webchat',
                messages: [],
            } as unknown as DispatchStreamEvent['payload'],
        };
        FakeEventSource.last!.emitFrame('observability', env);

        expect(onEvent).toHaveBeenCalledWith(env);
    });

    it('does not fan an observability frame to a different topic handler', () => {
        const client = createRunnerClient(freshBase());
        const onEvent = vi.fn();
        client.observabilityStream({ event: onEvent });

        FakeEventSource.last!.emitFrame('animation', {
            type: 'edge.traversed',
            graphId: 'g',
            edgeId: 'e',
        });
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('drops malformed frames without throwing', () => {
        const client = createRunnerClient(freshBase());
        const onEvent = vi.fn();
        client.observabilityStream({ event: onEvent });

        expect(() => FakeEventSource.last!.emitRaw('not-json')).not.toThrow();
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('tolerates a stream error (the hub owns auto-reconnect)', () => {
        const client = createRunnerClient(freshBase());
        client.observabilityStream({ event: () => {} });
        expect(() => FakeEventSource.last!.fireError()).not.toThrow();
    });

    it('returns a StreamSubscription whose close() unsubscribes the topic', () => {
        const client = createRunnerClient(freshBase());
        const onEvent = vi.fn();
        const sub = client.observabilityStream({ event: onEvent });
        expect(typeof sub.close).toBe('function');
        sub.close();
        FakeEventSource.last!.emitFrame('observability', { seq: 1, kind: 'dispatch', payload: {} });
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('forwards observability frames verbatim', () => {
        const client = createRunnerClient(freshBase());
        const onEvent = vi.fn();
        client.observabilityStream({ event: onEvent });

        const env: DispatchStreamEvent = {
            seq: 5,
            kind: 'observability',
            payload: {
                type: 'llm.chunk',
                eventId: 'd-1',
            } as unknown as DispatchStreamEvent['payload'],
        };
        FakeEventSource.last!.emitFrame('observability', env);
        expect(onEvent).toHaveBeenCalledWith(env);
    });
});

describe('runnerClient.animationStream (multiplexed)', () => {
    it('delivers bare EdgeTraversedEvent payloads from the animation topic', () => {
        const client = createRunnerClient(freshBase());
        const onEvent = vi.fn();
        client.animationStream({ event: onEvent });

        const ev = { type: 'edge.traversed', graphId: 'g', edgeId: 'e1' };
        FakeEventSource.last!.emitFrame('animation', ev);
        expect(onEvent).toHaveBeenCalledWith(ev);
    });
});

describe('runnerClient.graphStatusStream (multiplexed)', () => {
    it('subscribes status:<id> and forwards the running payload', () => {
        const client = createRunnerClient(freshBase());
        const onEvent = vi.fn();
        client.graphStatusStream('g-1', onEvent);

        const payload = { running: [{ nodeId: 'n', phase: 'running' }] };
        FakeEventSource.last!.emitFrame('status:g-1', payload);
        expect(onEvent).toHaveBeenCalledWith(payload);

        onEvent.mockClear();
        FakeEventSource.last!.emitFrame('status:g-2', { running: [] });
        expect(onEvent).not.toHaveBeenCalled();
    });
});

describe('runnerClient.permissionGateStream (multiplexed)', () => {
    it('subscribes permission:<gid>:<nid> and forwards requests', () => {
        const client = createRunnerClient(freshBase());
        const onReq = vi.fn();
        client.permissionGateStream('g-1', 'perm-1', onReq);

        const req = {
            callId: 'c1',
            toolName: 'bash',
            permissionNodeId: 'perm-1',
            args: {},
            ts: 't',
        };
        FakeEventSource.last!.emitFrame('permission:g-1:perm-1', req);
        expect(onReq).toHaveBeenCalledWith(req);
    });
});
