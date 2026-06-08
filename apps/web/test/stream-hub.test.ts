import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamHub } from '../lib/stream-hub';

class FakeEventSource {
    static created: FakeEventSource[] = [];
    url: string;
    onmessage: ((ev: MessageEvent<string>) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    closed = false;
    constructor(url: string) {
        this.url = url;
        FakeEventSource.created.push(this);
    }
    close(): void {
        this.closed = true;
    }
}

type Listener = (ev: { persisted?: boolean }) => void;
const winListeners = new Map<string, Listener[]>();
function fireWindow(type: string, ev: { persisted?: boolean } = {}): void {
    for (const l of winListeners.get(type) ?? []) l(ev);
}

beforeEach(() => {
    FakeEventSource.created = [];
    winListeners.clear();
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
        FakeEventSource;
    (globalThis as unknown as { window: unknown }).window = {
        addEventListener: (type: string, l: Listener) => {
            const cur = winListeners.get(type) ?? [];
            cur.push(l);
            winListeners.set(type, cur);
        },
    };
});

afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    delete (globalThis as unknown as { window?: unknown }).window;
});

const openEvents = (): FakeEventSource[] => FakeEventSource.created.filter((s) => !s.closed);

describe('StreamHub lifecycle', () => {
    it('opens exactly one EventSource across multiple topic subscriptions', () => {
        const hub = new StreamHub('http://runner.test/api');
        hub.on('observability', () => {});
        hub.on('animation', () => {});
        hub.on('status:g1', () => {});
        expect(FakeEventSource.created).toHaveLength(1);
    });

    it('closes the transport on pagehide and frees the slot', () => {
        const hub = new StreamHub('http://runner.test/api');
        hub.on('observability', () => {});
        expect(openEvents()).toHaveLength(1);

        fireWindow('pagehide');
        expect(FakeEventSource.created[0]!.closed).toBe(true);
        expect(openEvents()).toHaveLength(0);
    });

    it('reopens a fresh transport on bfcache restore (pageshow persisted) while subscribed', () => {
        const hub = new StreamHub('http://runner.test/api');
        hub.on('observability', () => {});
        fireWindow('pagehide');
        expect(openEvents()).toHaveLength(0);

        fireWindow('pageshow', { persisted: true });
        expect(openEvents()).toHaveLength(1);
        expect(FakeEventSource.created).toHaveLength(2);
    });

    it('does NOT reopen on a non-persisted pageshow (normal load handles its own open)', () => {
        const hub = new StreamHub('http://runner.test/api');
        hub.on('observability', () => {});
        fireWindow('pagehide');
        fireWindow('pageshow', { persisted: false });
        expect(openEvents()).toHaveLength(0);
    });

    it('does NOT reopen on pageshow when nothing is subscribed anymore', () => {
        const hub = new StreamHub('http://runner.test/api');
        const off = hub.on('observability', () => {});
        off();
        fireWindow('pagehide');
        fireWindow('pageshow', { persisted: true });
        expect(openEvents()).toHaveLength(0);
    });
});
