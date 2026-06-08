'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node, ObservabilityEvent } from '@fabritorio/types';
import { subscribeLiveEvents } from './live-bus';
import { buildTransientReducer, NodeTransient, TransientReducer } from './node-transients';

export interface NodeTransients {
    byNode: ReadonlyMap<string, NodeTransient>;
}

export function useNodeTransients(deps: {
    nodes: ReadonlyArray<Node>;
    events: ReadonlyArray<ObservabilityEvent>;
}): NodeTransients {
    const { nodes, events } = deps;

    const reducer = useMemo<TransientReducer>(
        () => buildTransientReducer({ nodes }, events),
        [nodes, events],
    );

    const reducerRef = useRef(reducer);
    reducerRef.current = reducer;

    const [byNode, setByNode] = useState<ReadonlyMap<string, NodeTransient>>(() => new Map());

    useEffect(() => {
        const next = snapshot(reducer, nodes);
        setByNode((prev) => (sameTransients(prev, next) ? prev : next));
    }, [reducer, nodes]);

    const nodeIdsRef = useRef<ReadonlyArray<string>>(nodes.map((n) => n.id));
    nodeIdsRef.current = useMemo(() => nodes.map((n) => n.id), [nodes]);

    useEffect(() => {
        const off = subscribeLiveEvents((ev) => {
            const r = reducerRef.current;
            r.ingest(ev);
            const next = snapshot(r, nodeIdsRef.current);
            setByNode((prev) => (sameTransients(prev, next) ? prev : next));
        });
        return off;
        // Stable for the controller's lifetime — reads the live reducer/nodes
        // via refs, so it must not re-subscribe on graph edits.
    }, []);

    return { byNode };
}

function snapshot(
    reducer: TransientReducer,
    nodes: ReadonlyArray<Node | string>,
): ReadonlyMap<string, NodeTransient> {
    const out = new Map<string, NodeTransient>();
    for (const n of nodes) {
        const id = typeof n === 'string' ? n : n.id;
        const t = reducer.transientFor(id);
        if (t) out.set(id, t);
    }
    return out;
}

function sameTransients(
    a: ReadonlyMap<string, NodeTransient>,
    b: ReadonlyMap<string, NodeTransient>,
): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const [k, va] of a) {
        const vb = b.get(k);
        if (!vb || !sameTransient(va, vb)) return false;
    }
    return true;
}

function sameTransient(a: NodeTransient, b: NodeTransient): boolean {
    return (
        a.toolArgPreview === b.toolArgPreview &&
        a.toolExitOk === b.toolExitOk &&
        a.routerTrying === b.routerTrying &&
        a.fellThroughReason === b.fellThroughReason &&
        a.stoppedReason === b.stoppedReason &&
        a.iter?.n === b.iter?.n &&
        a.iter?.max === b.iter?.max
    );
}
