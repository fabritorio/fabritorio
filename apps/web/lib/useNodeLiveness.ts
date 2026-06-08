'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node, ObservabilityEvent } from '@fabritorio/types';
import { buildDispatchIndex, DispatchIndex } from './dispatch-index';
import { subscribeLiveEvents } from './live-bus';
import {
    bumpGlow,
    decay,
    GLOW_HALF_LIFE_MS,
    LIVENESS_EPSILON,
    PHOSPHOR_HALF_LIFE_MS,
} from './node-liveness';

export interface NodeLiveness {
    phaseLabels: ReadonlyMap<string, string>;
}

export function useNodeLiveness(deps: {
    wrapperRef: React.RefObject<HTMLElement | null>;
    nodes: ReadonlyArray<Node>;
    events: ReadonlyArray<ObservabilityEvent>;
}): NodeLiveness {
    const { wrapperRef, nodes, events } = deps;

    const index = useMemo<DispatchIndex>(
        () => buildDispatchIndex({ nodes }, events),
        [nodes, events],
    );

    const [phaseLabels, setPhaseLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
    useEffect(() => {
        const next = snapshotLabels(index, nodes);
        setPhaseLabels((prev) => (sameLabels(prev, next) ? prev : next));
    }, [index, nodes]);

    const indexRef = useRef(index);
    indexRef.current = index;

    interface LiveState {
        glow: number;
        phosphor: number;
        reasoning: boolean;
    }
    const liveRef = useRef<Map<string, LiveState>>(new Map());
    const rafRef = useRef<number | null>(null);
    const lastTickRef = useRef<number>(0);

    const wrapperRefStable = wrapperRef;

    useEffect(() => {
        function nodeEl(id: string): HTMLElement | null {
            const root = wrapperRefStable.current;
            if (!root) return null;
            return root.querySelector<HTMLElement>(`.react-flow__node[data-id="${cssEscape(id)}"]`);
        }

        function tick(now: number): void {
            const live = liveRef.current;
            const last = lastTickRef.current || now;
            const elapsed = now - last;
            lastTickRef.current = now;

            for (const [id, st] of live) {
                st.glow = decay(st.glow, elapsed, GLOW_HALF_LIFE_MS);
                st.phosphor = decay(st.phosphor, elapsed, PHOSPHOR_HALF_LIFE_MS);
                const el = nodeEl(id);
                if (el) {
                    el.style.setProperty('--fab-stream-glow', st.glow.toFixed(3));
                    el.style.setProperty('--fab-recent', st.phosphor.toFixed(3));
                    el.style.setProperty('--fab-stream-reasoning', st.reasoning ? '1' : '0');
                }
                if (st.glow < LIVENESS_EPSILON && st.phosphor < LIVENESS_EPSILON) {
                    if (el) {
                        el.style.removeProperty('--fab-stream-glow');
                        el.style.removeProperty('--fab-recent');
                        el.style.removeProperty('--fab-stream-reasoning');
                    }
                    live.delete(id);
                }
            }

            if (live.size > 0) {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                rafRef.current = null;
                lastTickRef.current = 0;
            }
        }

        function ensureLoop(): void {
            if (rafRef.current === null) {
                lastTickRef.current = 0;
                rafRef.current = requestAnimationFrame(tick);
            }
        }

        const off = subscribeLiveEvents((ev) => {
            const idx = indexRef.current;
            idx.ingest(ev);

            const owner = idx.resolveOwner(ev);
            if (!owner) return;

            const live = liveRef.current;
            let st = live.get(owner);
            if (!st) {
                st = { glow: 0, phosphor: 0, reasoning: false };
                live.set(owner, st);
            }

            if (ev.type === 'llm.chunk') {
                const isReasoning = ev.kind === 'reasoning';
                st.glow = bumpGlow(st.glow, isReasoning ? 'reasoning' : 'content');
                st.reasoning = isReasoning;
            }
            st.phosphor = 1;

            ensureLoop();

            const nextLabel = idx.phaseFor(owner);
            setPhaseLabels((prev) => {
                const cur = prev.get(owner) ?? null;
                if (cur === nextLabel) return prev;
                const next = new Map(prev);
                if (nextLabel === null) next.delete(owner);
                else next.set(owner, nextLabel);
                return next;
            });
        });

        return () => {
            off();
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            const live = liveRef.current;
            for (const id of live.keys()) {
                const el = nodeEl(id);
                if (el) {
                    el.style.removeProperty('--fab-stream-glow');
                    el.style.removeProperty('--fab-recent');
                    el.style.removeProperty('--fab-stream-reasoning');
                }
            }
            live.clear();
        };
        // Subscription is stable for the hook's lifetime — it reads the live
        // index/wrapper via refs, so it must NOT re-subscribe on graph edits.
    }, [wrapperRefStable]);

    return { phaseLabels };
}

function snapshotLabels(
    index: DispatchIndex,
    nodes: ReadonlyArray<Node>,
): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const n of nodes) {
        const label = index.phaseFor(n.id);
        if (label !== null) out.set(n.id, label);
    }
    return out;
}

function sameLabels(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
        if (b.get(k) !== v) return false;
    }
    return true;
}

function cssEscape(id: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(id);
    }
    return id.replace(/["\\]/g, '\\$&');
}
