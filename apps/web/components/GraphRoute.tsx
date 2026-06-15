'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Graph } from '@fabritorio/types';
import { Playground } from './Playground';
import { createRunnerClient } from '@/lib/runner-client';
import { loadPalette } from '@/lib/palette';
import { useFabritorioStore } from '@/lib/store';
import { usePopstateSync } from '@/lib/useDrillNavigation';
import { parseLocationToDrillState } from '@/lib/breadcrumb-stack';

type Resolved = { state: 'loading' } | { state: 'found'; graph: Graph } | { state: 'missing' };

// Static export: `_` is the only prerendered route, so the real id never
// arrives via `idProp` — it lives in the committed URL.
const PLACEHOLDER_ID = '_';

export function GraphRoute({ id: idProp }: { id: string }) {
    const client = useMemo(() => createRunnerClient(), []);
    const router = useRouter();
    const pathname = usePathname();

    const readId = useCallback((): string => {
        if (typeof window === 'undefined') return idProp;
        const { currentGraphId } = parseLocationToDrillState(
            window.location.pathname,
            window.location.search,
        );
        return currentGraphId ?? idProp;
    }, [idProp]);

    // A soft navigation renders this component before Next commits the new URL,
    // so the eager read can land on the placeholder; heal once `pathname` reports
    // the commit. Only while still on the placeholder — afterwards popstate/drill
    // is owned by the store, not this read.
    const [graphId, setGraphId] = useState<string>(readId);
    useEffect(() => {
        if (graphId !== PLACEHOLDER_ID) return;
        const id = readId();
        if (id !== PLACEHOLDER_ID) setGraphId(id);
    }, [pathname, readId, graphId]);

    const seeded = useRef(false);
    if (!seeded.current && typeof window !== 'undefined') {
        seeded.current = true;
        const { fromStack } = parseLocationToDrillState(
            window.location.pathname,
            window.location.search,
        );
        useFabritorioStore.getState().setFromStack(fromStack);
    }

    usePopstateSync();

    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const [resolved, setResolved] = useState<Resolved>({ state: 'loading' });

    const hasStaleGraph = useFabritorioStore((s) => s.graph.nodes.length > 0);

    useEffect(() => {
        // Don't fetch the placeholder; hold loading until the real id resolves.
        if (graphId === PLACEHOLDER_ID) {
            setResolved({ state: 'loading' });
            return;
        }
        let cancelled = false;
        setResolved({ state: 'loading' });
        void loadPalette().catch(() => {
            /* fall back to local mirror */
        });
        void (async () => {
            try {
                const summary = await client.getGraph(graphId);
                if (cancelled) return;
                if (summary) {
                    setResolved({ state: 'found', graph: summary.graph });
                    return;
                }
                setResolved({ state: 'missing' });
            } catch {
                if (!cancelled) setResolved({ state: 'missing' });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, graphId]);

    if (resolved.state === 'loading' && !hasStaleGraph) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
                Loading graph{' '}
                {mounted && graphId !== PLACEHOLDER_ID ? `${graphId.slice(0, 8)}…` : '…'}
            </div>
        );
    }
    if (resolved.state === 'missing') {
        return (
            <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-zinc-50 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
                <p className="text-sm">
                    No graph with id <code className="font-mono">{graphId}</code>.
                </p>
                <button
                    type="button"
                    onClick={() => router.push('/')}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                >
                    Back to picker
                </button>
            </div>
        );
    }
    return <Playground graphId={graphId} />;
}
