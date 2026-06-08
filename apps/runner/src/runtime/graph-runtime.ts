import type { ActiveAsk, Edge, Graph, Node, NodeRuntimeState, NodeType } from '@fabritorio/types';
import type { DispatchListener, EventBus } from './event-bus.js';

export type LockState = 'idle' | 'running';

export interface NodeContext {
    graph: Graph;
    node: Node;
    bus: EventBus;
    outgoing: Edge[];
    incoming: Edge[];
    topicFor(edge: Edge): string;
}

export interface SourceHandle {
    deactivate(): void | Promise<void>;
}

export interface NodeBinding {
    activate?(ctx: NodeContext): Promise<SourceHandle | null> | SourceHandle | null;
    receiver?(ctx: NodeContext, edge: Edge): DispatchListener | null;
    dependencies?(ctx: NodeContext): Promise<string[]> | string[];
}

export interface NodeRegistry {
    register(type: NodeType, binding: NodeBinding): void;
    get(type: NodeType): NodeBinding | undefined;
}

export function createNodeRegistry(): NodeRegistry {
    const bindings = new Map<NodeType, NodeBinding>();
    return {
        register(type, binding) {
            bindings.set(type, binding);
        },
        get(type) {
            return bindings.get(type);
        },
    };
}

export interface LoadedGraph {
    graph: Graph;
    status: LockState;
    sources: Map<string, SourceHandle>;
    subscriptions: string[];
    dependsOn: Set<string>;
    nodeStates: ReadonlyMap<string, NodeRuntimeState>;
    unload(): Promise<void>;
}

export type NodeStatesListener = (nodeStates: ReadonlyMap<string, NodeRuntimeState>) => void;

export function graphIsAutonomous(graph: Graph): boolean {
    return graph.nodes.some((n) => n.type === 'trigger' && n.paused !== true);
}

export interface GraphRuntimeRegistry {
    load(graph: Graph): Promise<LoadedGraph>;
    unload(graphId: string): Promise<boolean>;
    get(graphId: string): LoadedGraph | undefined;
    list(): LoadedGraph[];
    listLoaded(): string[];
    ensureLoaded(graphId: string): Promise<void>;
    syncPin(graph: Graph): Promise<void>;
    reloadDependents(graphId: string): Promise<void>;
    sweepNow(): Promise<void>;
    subscribeNodeStates(graphId: string, listener: NodeStatesListener): () => void;
    subscribeAllNodeStates(
        listener: (graphId: string, states: ReadonlyMap<string, NodeRuntimeState>) => void,
    ): () => void;
}

export interface GraphRuntimeOptions {
    bus: EventBus;
    nodes: NodeRegistry;
    getGraph?: (id: string) => Promise<Graph | undefined>;
    idleTtlMs?: number;
    awaitProbe?: (args: {
        graphId: string;
        nodeId: string;
        eventId: string;
        phase: 'pre' | 'post';
    }) => Promise<void>;
}

interface InternalRecord extends LoadedGraph {
    unsubFns: Array<() => void>;
    inFlight: number;
    stale: boolean;
    nodeStatesMutable: Map<string, NodeRuntimeState>;
    askByChildEventId: Map<string, { callerNodeId: string; askCallId: string }>;
    nodeStatesListeners: Set<NodeStatesListener>;
}

type AllNodeStatesListener = (
    graphId: string,
    states: ReadonlyMap<string, NodeRuntimeState>,
) => void;

export function createGraphRuntimeRegistry(opts: GraphRuntimeOptions): GraphRuntimeRegistry {
    const loaded = new Map<string, InternalRecord>();

    const allNodeStatesWrappers = new Map<AllNodeStatesListener, Set<NodeStatesListener>>();

    function attachAllListenerToRecord(rec: InternalRecord, listener: AllNodeStatesListener): void {
        const wrapper: NodeStatesListener = (states) => listener(rec.graph.id!, states);
        rec.nodeStatesListeners.add(wrapper);
        allNodeStatesWrappers.get(listener)?.add(wrapper);
    }

    const pinned = new Set<string>();
    const lastActivity = new Map<string, number>();
    const IDLE_TTL_MS = opts.idleTtlMs ?? 5 * 60_000;

    async function unloadInternal(rec: InternalRecord): Promise<void> {
        for (const src of rec.sources.values()) {
            await src.deactivate();
        }
        for (const off of rec.unsubFns) off();
        rec.unsubFns.length = 0;
        rec.subscriptions.length = 0;
        rec.sources.clear();
        rec.nodeStatesMutable.clear();
        rec.askByChildEventId.clear();
        rec.nodeStatesListeners.clear();
        rec.status = 'idle';
    }

    async function load(graph: Graph): Promise<LoadedGraph> {
        if (!graph.id) {
            throw new Error('graph.id required to load');
        }
        if (loaded.has(graph.id)) {
            throw new Error(`graph ${graph.id} already loaded`);
        }

        const incomingByNode = new Map<string, Edge[]>();
        const outgoingByNode = new Map<string, Edge[]>();
        for (const node of graph.nodes) {
            incomingByNode.set(node.id, []);
            outgoingByNode.set(node.id, []);
        }
        for (const edge of graph.edges) {
            const srcOut = outgoingByNode.get(edge.source.node_id);
            const tgtIn = incomingByNode.get(edge.target.node_id);
            if (!srcOut || !tgtIn) {
                throw new Error(
                    `edge ${edge.id} references unknown node (${edge.source.node_id} → ${edge.target.node_id})`,
                );
            }
            srcOut.push(edge);
            tgtIn.push(edge);
        }

        const rec: InternalRecord = {
            graph,
            status: 'idle',
            sources: new Map(),
            subscriptions: [],
            dependsOn: new Set(),
            unsubFns: [],
            inFlight: 0,
            stale: false,
            nodeStates: new Map<string, NodeRuntimeState>(),
            nodeStatesMutable: new Map<string, NodeRuntimeState>(),
            askByChildEventId: new Map(),
            nodeStatesListeners: new Set<NodeStatesListener>(),
            unload: () => unloadAndForget(graph.id!),
        };
        rec.nodeStates = rec.nodeStatesMutable;

        const ownNodeIds = new Set(graph.nodes.map((n) => n.id));

        function fireListeners(): void {
            const snapshot: ReadonlyMap<string, NodeRuntimeState> = new Map(rec.nodeStatesMutable);
            const listeners = Array.from(rec.nodeStatesListeners);
            for (const listener of listeners) {
                try {
                    listener(snapshot);
                } catch {
                    // best-effort — a misbehaving subscriber doesn't poison the rest
                }
            }
        }

        function parseTs(ts: string | number | undefined): number {
            if (typeof ts === 'number') return ts;
            if (typeof ts === 'string') {
                const parsed = Date.parse(ts);
                if (!Number.isNaN(parsed)) return parsed;
            }
            return Date.now();
        }

        function popCallerAsk(eventId: string): boolean {
            const childAsk = rec.askByChildEventId.get(eventId);
            if (!childAsk) return false;
            rec.askByChildEventId.delete(eventId);
            const state = rec.nodeStatesMutable.get(childAsk.callerNodeId);
            if (!state) return false;
            const next = state.activeAsks.filter((a) => a.askCallId !== childAsk.askCallId);
            if (next.length === state.activeAsks.length) return false;
            rec.nodeStatesMutable.set(childAsk.callerNodeId, {
                ...state,
                phase: next.length === 0 ? 'running' : 'asking',
                activeAsks: next,
            });
            return true;
        }

        function clearOwnEntry(eventId: string): boolean {
            let owner: string | undefined;
            for (const [nodeId, state] of rec.nodeStatesMutable) {
                if (state.dispatchEventId === eventId) {
                    owner = nodeId;
                    break;
                }
            }
            if (!owner) return false;
            const state = rec.nodeStatesMutable.get(owner)!;
            for (const a of state.activeAsks) {
                for (const [childId, ask] of rec.askByChildEventId) {
                    if (ask.askCallId === a.askCallId) {
                        rec.askByChildEventId.delete(childId);
                    }
                }
            }
            rec.nodeStatesMutable.delete(owner);
            return true;
        }

        const offObs = opts.bus.subscribeObservability((ev) => {
            if (ev.type === 'gateway.received') {
                if (!ownNodeIds.has(ev.node_id)) return;
                rec.nodeStatesMutable.set(ev.node_id, {
                    nodeId: ev.node_id,
                    dispatchEventId: ev.eventId,
                    phase: 'running',
                    startedAt: parseTs(ev.ts),
                    activeAsks: [],
                });
                fireListeners();
                return;
            }
            if (ev.type === 'output.emitted' || ev.type === 'chain.stopped') {
                const popped = popCallerAsk(ev.eventId);
                const cleared = clearOwnEntry(ev.eventId);
                if (popped || cleared) fireListeners();
            }
        });
        rec.unsubFns.push(offObs);

        const offDispatch = opts.bus.subscribeDispatch((ev) => {
            const meta = ev.meta;
            if (!meta) return;
            const askCallId = meta.ask_call_id;
            const callerNodeId = meta.ask_caller_node_id;
            const calleeNodeId = meta.ask_callee_node_id;
            if (typeof askCallId !== 'string') return;
            if (typeof callerNodeId !== 'string') return;
            if (typeof calleeNodeId !== 'string') return;
            if (rec.askByChildEventId.has(ev.eventId)) return;
            if (typeof meta.port === 'string') return;
            if (!ownNodeIds.has(callerNodeId)) return;
            const state = rec.nodeStatesMutable.get(callerNodeId);
            if (!state) return;
            if (state.activeAsks.some((a) => a.askCallId === askCallId)) return;
            const ask: ActiveAsk = {
                askCallId,
                targetNodeId: calleeNodeId,
                startedAt: typeof ev.timestamp === 'number' ? ev.timestamp : Date.now(),
            };
            rec.askByChildEventId.set(ev.eventId, { callerNodeId, askCallId });
            rec.nodeStatesMutable.set(callerNodeId, {
                ...state,
                phase: 'asking',
                activeAsks: [...state.activeAsks, ask],
            });
            fireListeners();
        });
        rec.unsubFns.push(offDispatch);

        function ctxFor(node: Node): NodeContext {
            return {
                graph,
                node,
                bus: opts.bus,
                outgoing: outgoingByNode.get(node.id) ?? [],
                incoming: incomingByNode.get(node.id) ?? [],
                topicFor: (edge) => edge.id,
            };
        }

        for (const node of graph.nodes) {
            const binding = opts.nodes.get(node.type);
            if (!binding?.receiver) continue;
            const ctx = ctxFor(node);
            for (const edge of ctx.incoming) {
                const listener = binding.receiver(ctx, edge);
                if (!listener) continue;
                const topic = ctx.topicFor(edge);
                const targetNodeId = node.id;
                const wrapped: DispatchListener = async (event) => {
                    rec.inFlight++;
                    lastActivity.set(graph.id!, Date.now());
                    try {
                        if (opts.awaitProbe) {
                            await opts.awaitProbe({
                                graphId: graph.id!,
                                nodeId: targetNodeId,
                                eventId: event.eventId,
                                phase: 'pre',
                            });
                        }
                        await listener(event);
                        if (opts.awaitProbe) {
                            await opts.awaitProbe({
                                graphId: graph.id!,
                                nodeId: targetNodeId,
                                eventId: event.eventId,
                                phase: 'post',
                            });
                        }
                    } finally {
                        rec.inFlight--;
                        if (rec.inFlight === 0 && rec.stale && loaded.get(graph.id!) === rec) {
                            rec.stale = false;
                            void reloadGraphInPlace(graph.id!).catch(() => undefined);
                        }
                    }
                };
                const off = opts.bus.subscribeTopic(topic, wrapped);
                rec.unsubFns.push(off);
                rec.subscriptions.push(topic);
            }
        }

        try {
            for (const node of graph.nodes) {
                const binding = opts.nodes.get(node.type);
                if (!binding?.activate) continue;
                const result = await binding.activate(ctxFor(node));
                if (result) rec.sources.set(node.id, result);
            }
        } catch (err) {
            await unloadInternal(rec).catch(() => undefined);
            throw err;
        }

        for (const node of graph.nodes) {
            const binding = opts.nodes.get(node.type);
            if (!binding?.dependencies) continue;
            try {
                const ids = await binding.dependencies(ctxFor(node));
                for (const id of ids) rec.dependsOn.add(id);
            } catch {
                // best-effort
            }
        }

        rec.status = 'running';
        for (const listener of allNodeStatesWrappers.keys()) {
            attachAllListenerToRecord(rec, listener);
        }
        loaded.set(graph.id, rec);
        return rec;
    }

    async function reloadGraphInPlace(graphId: string): Promise<void> {
        if (!opts.getGraph) return;
        if (!loaded.has(graphId)) return;
        await unloadAndForget(graphId);
        const fresh = await opts.getGraph(graphId);
        if (!fresh) return;
        try {
            await load(fresh);
        } catch {
            // Best-effort: if the rebuild fails (e.g. the user just saved a
            // graph in an inconsistent intermediate state), leave it unloaded.
            // The next load attempt — explicit or via panel remount — will retry.
        }
    }

    async function unloadAndForget(graphId: string): Promise<void> {
        const rec = loaded.get(graphId);
        if (!rec) return;
        loaded.delete(graphId);
        lastActivity.delete(graphId);
        await unloadInternal(rec);
    }

    async function ensureLoaded(graphId: string): Promise<void> {
        if (!loaded.has(graphId)) {
            if (!opts.getGraph) throw new Error('ensureLoaded: getGraph not configured');
            const graph = await opts.getGraph(graphId);
            if (!graph) throw new Error(`graph ${graphId} not found`);
            await load(graph);
        }
        lastActivity.set(graphId, Date.now());
    }

    async function syncPin(graph: Graph): Promise<void> {
        const id = graph.id;
        if (!id) return;
        if (graphIsAutonomous(graph) && !graph.stopped) {
            pinned.add(id);
            if (!loaded.has(id)) await load(graph);
        } else {
            pinned.delete(id);
        }
    }

    async function sweep(): Promise<void> {
        const now = Date.now();
        for (const [id, rec] of loaded) {
            if (pinned.has(id)) continue;
            if (rec.inFlight > 0) continue;
            if (now - (lastActivity.get(id) ?? now) <= IDLE_TTL_MS) continue;
            await unloadAndForget(id);
        }
    }
    const sweepTimer = setInterval(() => {
        void sweep().catch(() => undefined);
    }, 60_000);
    sweepTimer.unref?.();

    return {
        load,
        ensureLoaded,
        syncPin,
        sweepNow: sweep,
        async unload(graphId) {
            const rec = loaded.get(graphId);
            pinned.delete(graphId);
            if (!rec) return false;
            await unloadAndForget(graphId);
            return true;
        },
        get(graphId) {
            return loaded.get(graphId);
        },
        list() {
            return [...loaded.values()];
        },
        listLoaded() {
            return [...loaded.keys()];
        },
        subscribeAllNodeStates(listener) {
            const wrappers = new Set<NodeStatesListener>();
            allNodeStatesWrappers.set(listener, wrappers);
            for (const rec of loaded.values()) {
                attachAllListenerToRecord(rec, listener);
            }
            return () => {
                const set = allNodeStatesWrappers.get(listener);
                allNodeStatesWrappers.delete(listener);
                if (!set) return;
                for (const rec of loaded.values()) {
                    for (const wrapper of set) rec.nodeStatesListeners.delete(wrapper);
                }
            };
        },
        subscribeNodeStates(graphId, listener) {
            const rec = loaded.get(graphId);
            if (!rec) return () => undefined;
            rec.nodeStatesListeners.add(listener);
            return () => {
                const cur = loaded.get(graphId);
                cur?.nodeStatesListeners.delete(listener);
            };
        },
        async reloadDependents(graphId) {
            const candidates: InternalRecord[] = [];
            for (const rec of loaded.values()) {
                if (rec.dependsOn.has(graphId)) candidates.push(rec);
            }
            for (const rec of candidates) {
                if (rec.inFlight > 0) {
                    rec.stale = true;
                    continue;
                }
                await reloadGraphInPlace(rec.graph.id!);
            }
        },
    };
}
