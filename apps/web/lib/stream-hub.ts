import { sseUrl } from './runner-client';

type Handler = (payload: unknown) => void;

export class StreamHub {
    private es: EventSource | null = null;
    private readonly subs = new Map<string, Set<Handler>>();
    private lifecycleBound = false;

    constructor(private readonly base: string) {}

    private bindLifecycle(): void {
        if (this.lifecycleBound) return;
        if (typeof window === 'undefined') return;
        this.lifecycleBound = true;
        window.addEventListener('pagehide', () => {
            this.es?.close();
            this.es = null;
        });
        window.addEventListener('pageshow', (ev: PageTransitionEvent) => {
            if (ev.persisted && this.subs.size > 0) this.ensure();
        });
    }

    private ensure(): void {
        this.bindLifecycle();
        if (this.es) return;
        const source = new EventSource(sseUrl(`${this.base}/stream`));
        source.onmessage = (ev: MessageEvent<string>) => {
            let frame: { topic?: unknown; payload?: unknown };
            try {
                frame = JSON.parse(ev.data) as { topic?: unknown; payload?: unknown };
            } catch {
                return;
            }
            if (typeof frame.topic !== 'string') return;
            const handlers = this.subs.get(frame.topic);
            if (!handlers) return;
            for (const h of Array.from(handlers)) {
                try {
                    h(frame.payload);
                } catch {
                    // best-effort — one bad handler doesn't poison the rest
                }
            }
        };
        source.onerror = () => {
            // EventSource auto-reconnects; the server re-seeds every topic on the
            // new connection. Handlers are idempotent under re-seed (permission
            // dedupes by callId; observability/dispatch by seq). Nothing to do.
        };
        this.es = source;
    }

    on(topic: string, handler: Handler): () => void {
        this.ensure();
        let set = this.subs.get(topic);
        if (!set) {
            set = new Set();
            this.subs.set(topic, set);
        }
        set.add(handler);
        return () => {
            const cur = this.subs.get(topic);
            if (!cur) return;
            cur.delete(handler);
            if (cur.size === 0) this.subs.delete(topic);
        };
    }
}

const hubsByBase = new Map<string, StreamHub>();

export function getStreamHub(base: string): StreamHub {
    let hub = hubsByBase.get(base);
    if (!hub) {
        hub = new StreamHub(base);
        hubsByBase.set(base, hub);
    }
    return hub;
}
