'use client';

import { useCallback, useRef, useState } from 'react';

export type OptimisticPhase = 'pending' | 'error';

export interface OptimisticGhostApi {
    hasNode(id: string): boolean;
    hasEdge(id: string): boolean;
    nodePhase(id: string): OptimisticPhase | null;
    edgePhase(id: string): OptimisticPhase | null;
    markNodePending(id: string): void;
    markEdgePending(id: string): void;
    settleNode(id: string): void;
    settleEdge(id: string): void;
    failNode(id: string): void;
    failEdge(id: string): void;
}

export function useOptimisticGhosts(): {
    api: OptimisticGhostApi;
    nodes: ReadonlyMap<string, OptimisticPhase>;
    edges: ReadonlyMap<string, OptimisticPhase>;
} {
    const [nodes, setNodes] = useState<Map<string, OptimisticPhase>>(() => new Map());
    const [edges, setEdges] = useState<Map<string, OptimisticPhase>>(() => new Map());

    const nodesRef = useRef(nodes);
    const edgesRef = useRef(edges);
    nodesRef.current = nodes;
    edgesRef.current = edges;

    const markNodePending = useCallback((id: string) => {
        setNodes((prev) => {
            const next = new Map(prev);
            next.set(id, 'pending');
            return next;
        });
    }, []);

    const markEdgePending = useCallback((id: string) => {
        setEdges((prev) => {
            const next = new Map(prev);
            next.set(id, 'pending');
            return next;
        });
    }, []);

    const settleNode = useCallback((id: string) => {
        setNodes((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
    }, []);

    const settleEdge = useCallback((id: string) => {
        setEdges((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
    }, []);

    const failNode = useCallback((id: string) => {
        setNodes((prev) => {
            const next = new Map(prev);
            next.set(id, 'error');
            return next;
        });
    }, []);

    const failEdge = useCallback((id: string) => {
        setEdges((prev) => {
            const next = new Map(prev);
            next.set(id, 'error');
            return next;
        });
    }, []);

    const api: OptimisticGhostApi = {
        hasNode: (id) => nodesRef.current.has(id),
        hasEdge: (id) => edgesRef.current.has(id),
        nodePhase: (id) => nodesRef.current.get(id) ?? null,
        edgePhase: (id) => edgesRef.current.get(id) ?? null,
        markNodePending,
        markEdgePending,
        settleNode,
        settleEdge,
        failNode,
        failEdge,
    };

    return { api, nodes, edges };
}

export const OPTIMISTIC_NODE_PENDING_CLASS = 'fabritorio-optimistic-pending-node';
export const OPTIMISTIC_NODE_ERROR_CLASS = 'fabritorio-optimistic-error-node';
export const OPTIMISTIC_EDGE_PENDING_CLASS = 'fabritorio-optimistic-pending-edge';
export const OPTIMISTIC_EDGE_ERROR_CLASS = 'fabritorio-optimistic-error-edge';

export const OPTIMISTIC_ERROR_DISSOLVE_MS = 900;
