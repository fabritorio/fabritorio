'use client';

import { create } from 'zustand';
import type {
    DispatchEvent,
    Edge,
    Graph,
    Node,
    ObservabilityEvent,
    Position,
} from '@fabritorio/types';

export type LogEntry = DispatchEvent | ObservabilityEvent;

export type RunState = 'idle' | 'creating' | 'running' | 'awaiting_input' | 'completed' | 'error';

interface FabritorioStoreState {
    graph: Graph;
    currentGraphId: string | null;
    fromStack: string[];
    lastSavedGraph: Graph | null;
    dispatchId: string | null;
    runState: RunState;
    events: LogEntry[];
    error: string | null;
    awaitingInput: boolean;
    selectedNodeId: string | null;
    setGraph(graph: Graph): void;
    setCurrentGraphId(id: string | null): void;
    setFromStack(stack: ReadonlyArray<string>): void;
    applyDrill(args: { graph: Graph; fromStack: ReadonlyArray<string> }): void;
    markGraphSaved(graph: Graph): void;
    setRunState(state: RunState): void;
    setDispatchId(id: string | null): void;
    setError(error: string | null): void;
    appendEvent(event: LogEntry): void;
    appendEvents(events: ReadonlyArray<LogEntry>): void;
    setEvents(events: ReadonlyArray<LogEntry>): void;
    clearEvents(): void;
    setAwaitingInput(value: boolean): void;
    setSelectedNodeId(id: string | null): void;
    addNode(node: Node): void;
    removeNode(id: string): void;
    updateNodePosition(id: string, position: Position): void;
    updateNodeConfig(id: string, patch: Partial<Node>): void;
    addEdge(edge: Edge): void;
    updateEdge(id: string, patch: Partial<Edge>): void;
    removeEdge(id: string): void;
    replaceGraph(graph: Graph): void;
    applyOpsResult(graph: Graph, remap: Record<string, string>): void;
}

function emptyGraph(): Graph {
    return { kind: 'l1', nodes: [], edges: [] };
}

function mutate(s: FabritorioStoreState, next: (g: Graph) => Graph): Partial<FabritorioStoreState> {
    return { graph: next(s.graph) };
}

function swapGraphState(
    s: FabritorioStoreState,
    graph: Graph,
): Pick<FabritorioStoreState, 'graph' | 'currentGraphId' | 'lastSavedGraph' | 'selectedNodeId'> {
    return {
        graph,
        currentGraphId: graph.id ?? s.currentGraphId,
        lastSavedGraph: graph.id ? graph : s.lastSavedGraph,
        selectedNodeId: null,
    };
}

export const useFabritorioStore = create<FabritorioStoreState>((set) => ({
    graph: emptyGraph(),
    currentGraphId: null,
    fromStack: [],
    lastSavedGraph: null,
    dispatchId: null,
    runState: 'idle',
    events: [],
    error: null,
    awaitingInput: false,
    selectedNodeId: null,
    setGraph: (graph) => set({ graph }),
    setCurrentGraphId: (id) => set({ currentGraphId: id }),
    setFromStack: (stack) => set({ fromStack: [...stack] }),
    applyDrill: ({ graph, fromStack }) =>
        set((s) => ({ ...swapGraphState(s, graph), fromStack: [...fromStack] })),
    markGraphSaved: (graph) => set({ lastSavedGraph: graph }),
    setRunState: (runState) => set({ runState }),
    setDispatchId: (dispatchId) => set({ dispatchId }),
    setError: (error) => set({ error }),
    appendEvent: (event) => set((s) => ({ events: [...s.events, event] })),
    appendEvents: (incoming) =>
        set((s) => (incoming.length === 0 ? s : { events: [...s.events, ...incoming] })),
    setEvents: (events) => set({ events: [...events] }),
    clearEvents: () => set({ events: [] }),
    setAwaitingInput: (awaitingInput) => set({ awaitingInput }),
    setSelectedNodeId: (id) => set({ selectedNodeId: id }),
    addNode: (node) => set((s) => mutate(s, (g) => ({ ...g, nodes: [...g.nodes, node] }))),
    removeNode: (id) =>
        set((s) => ({
            ...mutate(s, (g) => ({
                ...g,
                nodes: g.nodes.filter((n) => n.id !== id),
                edges: g.edges.filter((e) => e.source.node_id !== id && e.target.node_id !== id),
            })),
            selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        })),
    updateNodePosition: (id, position) =>
        set((s) => ({
            graph: {
                ...s.graph,
                nodes: s.graph.nodes.map((n) => (n.id === id ? ({ ...n, position } as Node) : n)),
            },
        })),
    updateNodeConfig: (id, patch) =>
        set((s) =>
            mutate(s, (g) => ({
                ...g,
                nodes: g.nodes.map((n) =>
                    n.id === id ? ({ ...n, ...patch, id: n.id, type: n.type } as Node) : n,
                ),
            })),
        ),
    addEdge: (edge) => set((s) => mutate(s, (g) => ({ ...g, edges: [...g.edges, edge] }))),
    updateEdge: (id, patch) =>
        set((s) =>
            mutate(s, (g) => ({
                ...g,
                edges: g.edges.map((e) =>
                    e.id === id
                        ? ({ ...e, ...patch, id: e.id, source: e.source, target: e.target } as Edge)
                        : e,
                ),
            })),
        ),
    removeEdge: (id) =>
        set((s) => mutate(s, (g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }))),
    replaceGraph: (graph) => set((s) => swapGraphState(s, graph)),
    applyOpsResult: (graph, remap) =>
        set((s) => {
            const remappedSelection =
                s.selectedNodeId && remap[s.selectedNodeId] ? remap[s.selectedNodeId]! : null;
            const nextSelection = remappedSelection ?? s.selectedNodeId;
            const stillExists = nextSelection
                ? graph.nodes.some((n) => n.id === nextSelection)
                : false;
            return {
                graph,
                lastSavedGraph: graph,
                selectedNodeId: stillExists ? nextSelection : null,
            };
        }),
}));
