'use client';

import { useCallback, useEffect, useMemo } from 'react';
import type { Graph } from '@fabritorio/types';
import { useFabritorioStore } from '@/lib/store';
import { createRunnerClient } from '@/lib/runner-client';
import {
    buildCrumbHref,
    buildStepIntoHref,
    parseLocationToDrillState,
    pushDrill,
    serializeFromParam,
    truncateDrill,
} from '@/lib/breadcrumb-stack';

export function useDrillNavigation() {
    const client = useMemo(() => createRunnerClient(), []);
    const applyDrill = useFabritorioStore((s) => s.applyDrill);

    const resolveGraph = useCallback(
        async (id: string): Promise<Graph | null> => {
            const fetched = await client.getGraph(id);
            return fetched?.graph ?? null;
        },
        [client],
    );

    const drillInto = useCallback(
        async (targetId: string) => {
            const { currentGraphId, fromStack } = useFabritorioStore.getState();
            if (!currentGraphId) return;
            const child = await resolveGraph(targetId);
            if (!child) return;
            const nextStack = pushDrill(fromStack, currentGraphId, targetId);
            applyDrill({ graph: child, fromStack: nextStack });
            const href = buildStepIntoHref(targetId, currentGraphId, serializeFromParam(fromStack));
            window.history.pushState(null, '', href);
        },
        [applyDrill, resolveGraph],
    );

    const drillToCrumb = useCallback(
        async (index: number) => {
            const { fromStack } = useFabritorioStore.getState();
            const target = fromStack[index];
            if (!target) return;
            const graph = await resolveGraph(target);
            if (!graph) return;
            const nextStack = truncateDrill(fromStack, index);
            applyDrill({ graph, fromStack: nextStack });
            window.history.pushState(null, '', buildCrumbHref(fromStack, index));
        },
        [applyDrill, resolveGraph],
    );

    return { drillInto, drillToCrumb };
}

export function usePopstateSync() {
    const client = useMemo(() => createRunnerClient(), []);
    const applyDrill = useFabritorioStore((s) => s.applyDrill);

    useEffect(() => {
        const onPopstate = () => {
            const { pathname, search } = window.location;
            const target = parseLocationToDrillState(pathname, search);
            if (!target.currentGraphId) return;
            const { currentGraphId } = useFabritorioStore.getState();
            if (target.currentGraphId === currentGraphId) {
                useFabritorioStore.getState().setFromStack(target.fromStack);
                return;
            }
            const targetId = target.currentGraphId;
            void (async () => {
                const graph = (await client.getGraph(targetId))?.graph ?? null;
                if (!graph) return;
                const now = parseLocationToDrillState(
                    window.location.pathname,
                    window.location.search,
                );
                if (now.currentGraphId !== targetId) return;
                applyDrill({ graph, fromStack: now.fromStack });
            })();
        };
        window.addEventListener('popstate', onPopstate);
        return () => window.removeEventListener('popstate', onPopstate);
    }, [client, applyDrill]);
}
