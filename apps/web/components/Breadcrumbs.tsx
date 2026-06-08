'use client';

import { useEffect, useState } from 'react';
import type { Graph, Node } from '@fabritorio/types';
import { createRunnerClient } from '@/lib/runner-client';
import { useFabritorioStore } from '@/lib/store';
import { useDrillNavigation } from '@/lib/useDrillNavigation';

const REF_FIELDS = ['l1_graph_id', 'ref_id'] as const;

function parentNodeLabel(parent: Graph, childId: string): string | null {
    for (const node of parent.nodes as Node[]) {
        const ref = node as { l1_graph_id?: string; ref_id?: string; display_name?: string };
        const refsChild = REF_FIELDS.some((f) => ref[f] === childId);
        if (refsChild && ref.display_name && ref.display_name.length > 0) {
            return ref.display_name;
        }
    }
    return null;
}

export function Breadcrumbs({ currentId }: { currentId: string }) {
    const stack = useFabritorioStore((s) => s.fromStack);
    const { drillToCrumb } = useDrillNavigation();
    const [names, setNames] = useState<Record<string, string>>({});

    useEffect(() => {
        let cancelled = false;
        const chain = [...stack, currentId];
        if (chain.length === 0) return;
        const client = createRunnerClient();
        void (async () => {
            const graphs: Record<string, Graph | null> = {};
            await Promise.all(
                chain.map(async (id) => {
                    try {
                        const summary = await client.getGraph(id);
                        graphs[id] = summary?.graph ?? null;
                    } catch {
                        graphs[id] = null;
                    }
                }),
            );
            if (cancelled) return;
            const next: Record<string, string> = {};
            chain.forEach((id, k) => {
                const parent = k > 0 ? graphs[chain[k - 1]!] : null;
                const fromNode = parent ? parentNodeLabel(parent, id) : null;
                const g = graphs[id];
                const fromGraph = g?.name && g.name.length > 0 ? g.name : null;
                next[id] = fromNode ?? fromGraph ?? id.slice(0, 8);
            });
            setNames(next);
        })();
        return () => {
            cancelled = true;
        };
        // Stack is captured by length+join; currentId is its own dep. We want
        // re-fetch when either changes.
    }, [stack.join(','), currentId]);

    if (stack.length === 0) return null;

    return (
        <nav
            aria-label="Containment trail"
            className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400"
        >
            {stack.map((id, i) => (
                <span key={`${id}:${i}`} className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => void drillToCrumb(i)}
                        className="rounded px-1 py-0.5 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        title={id}
                    >
                        {names[id] ?? id.slice(0, 8)}
                    </button>
                    <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-600">
                        ›
                    </span>
                </span>
            ))}
            <span
                className="rounded px-1 py-0.5 font-medium text-zinc-800 dark:text-zinc-100"
                title={currentId}
            >
                {names[currentId] ?? currentId.slice(0, 8)}
            </span>
        </nav>
    );
}
