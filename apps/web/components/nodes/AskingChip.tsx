'use client';

import { useEffect, useState } from 'react';
import type { ActiveAsk } from '@fabritorio/types';

interface Props {
    activeAsks: ReadonlyArray<ActiveAsk>;
    targetNames: ReadonlyMap<string, string>;
}

export function AskingChip({ activeAsks, targetNames }: Props) {
    const [now, setNow] = useState<number>(() => Date.now());
    useEffect(() => {
        if (activeAsks.length === 0) return;
        const handle = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(handle);
    }, [activeAsks.length]);

    if (activeAsks.length === 0) return null;

    const earliest = activeAsks.reduce(
        (min, a) => (a.startedAt < min ? a.startedAt : min),
        activeAsks[0]!.startedAt,
    );
    const seconds = ((now - earliest) / 1000).toFixed(1);

    const label =
        activeAsks.length === 1
            ? `→ ${displayFor(activeAsks[0]!.targetNodeId, targetNames)} · ${seconds}s`
            : `→ ${activeAsks.length} agents · ${seconds}s`;

    const tooltip = activeAsks
        .map((a) => {
            const ms = now - a.startedAt;
            return `${displayFor(a.targetNodeId, targetNames)} · ${(ms / 1000).toFixed(1)}s`;
        })
        .join('\n');

    return (
        <div
            className="fab-asking-chip"
            title={tooltip}
            // The chip sits absolutely on the node card's top-right corner,
            // outside the header text flow so the existing state badge stays
            // unobscured. Pointer events kept so the title tooltip works.
        >
            {label}
        </div>
    );
}

function displayFor(nodeId: string, names: ReadonlyMap<string, string>): string {
    const named = names.get(nodeId);
    if (named && named.length > 0) return named;
    return nodeId.length > 8 ? nodeId.slice(0, 8) : nodeId;
}
