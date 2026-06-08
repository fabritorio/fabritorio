'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    DebugGatewayNode,
    Edge,
    Node,
    NodeRuntimeStateWire,
    ObservabilityEvent,
    PermissionNode,
    PiAgentNode,
    Position,
} from '@fabritorio/types';
import { useFabritorioStore } from '@/lib/store';
import { isDispatchEvent } from '@/lib/event-rows';
import {
    bootstrapGraph,
    buildOfflineFallbackGraph,
    buildResetSampleGraph,
} from '@/lib/graph-bootstrap';
import { storeCurrentGraphId } from '@/lib/graph-persistence';
import {
    createRunnerClient,
    type LockState,
    type PermissionDecision,
    type PermissionDecisionRequest,
    type StreamSubscription,
} from '@/lib/runner-client';
import {
    buildSavedRefNode,
    isPresetSavable,
    nextNodeId,
    paletteKindsForGraphKind,
    savedRefKindsForGraphKind,
    suggestPresetName,
    type SavedRefKind,
} from '@/lib/node-factory';
import { createCliInvocationGraph } from '@/lib/cli-invocation-bootstrap';
import { sidecarChannelIdFor } from '@/lib/webchat';
import type { Fragment } from '@/lib/subgraph';
import { Canvas, type ParentContext } from './Canvas';
import { LogViewer, subscribeObservabilityStream } from './LogViewer';
import { subscribeTraversalStream } from '@/lib/useTraversalStream';
import { ThemeToggle } from './ThemeToggle';
import Link from 'next/link';
import { Palette } from './Palette';
import { Inspector } from './Inspector';
import { Breadcrumbs } from './Breadcrumbs';
import { WebchatPanel } from './WebchatPanel';
import { DebugGatewayPanel } from './DebugGatewayPanel';
import { PermissionPromptModal } from './PermissionPromptModal';
import { TriggerRunsModal } from './TriggerRunsModal';
import { AskCallsModal } from './AskCallsModal';
import { useDrillNavigation } from '@/lib/useDrillNavigation';

const AUTO_SAVE_DEBOUNCE_MS = 250;

interface Props {
    graphId?: string;
}

export function Playground({ graphId }: Props) {
    const { drillInto } = useDrillNavigation();
    const graph = useFabritorioStore((s) => s.graph);
    const events = useFabritorioStore((s) => s.events);
    const appendEvents = useFabritorioStore((s) => s.appendEvents);
    const clearEvents = useFabritorioStore((s) => s.clearEvents);
    const currentGraphId = useFabritorioStore((s) => s.currentGraphId);
    const lastSavedGraph = useFabritorioStore((s) => s.lastSavedGraph);
    const replaceGraph = useFabritorioStore((s) => s.replaceGraph);
    const markGraphSaved = useFabritorioStore((s) => s.markGraphSaved);
    const setError = useFabritorioStore((s) => s.setError);
    const runState = useFabritorioStore((s) => s.runState);
    const error = useFabritorioStore((s) => s.error);

    const selectedNodeId = useFabritorioStore((s) => s.selectedNodeId);
    const setSelectedNodeId = useFabritorioStore((s) => s.setSelectedNodeId);
    const addNode = useFabritorioStore((s) => s.addNode);
    const addEdge = useFabritorioStore((s) => s.addEdge);
    const removeNode = useFabritorioStore((s) => s.removeNode);
    const removeEdge = useFabritorioStore((s) => s.removeEdge);
    const updateNodePosition = useFabritorioStore((s) => s.updateNodePosition);
    const updateNodeConfig = useFabritorioStore((s) => s.updateNodeConfig);
    const updateEdge = useFabritorioStore((s) => s.updateEdge);
    const applyOpsResult = useFabritorioStore((s) => s.applyOpsResult);

    const hydrated = useRef(false);
    const client = useMemo(() => createRunnerClient(), []);

    const cloneSubtreeRef = useCallback(
        async (fragment: { nodes: Node[]; edges: Edge[] }) => {
            const destinationId = currentGraphId ?? '';
            if (!destinationId) {
                throw new Error('paste before graph is hydrated');
            }
            return client.cloneSubtree(destinationId, fragment);
        },
        [client, currentGraphId],
    );

    const applyGraphOpsRef = useCallback(
        async (ops: Parameters<typeof client.applyGraphOps>[1]) => {
            if (!currentGraphId) {
                throw new Error('graph is not hydrated yet');
            }
            return client.applyGraphOps(currentGraphId, ops);
        },
        [client, currentGraphId],
    );

    const [lockState, setLockState] = useState<LockState>('idle');
    const [runningNodes, setRunningNodes] = useState<ReadonlySet<string>>(() => new Set<string>());
    const [nodeRuntimeStates, setNodeRuntimeStates] = useState<ReadonlyArray<NodeRuntimeStateWire>>(
        () => [],
    );
    const [parentContext, setParentContext] = useState<ParentContext | null>(null);
    const [libraryRefreshKey, setLibraryRefreshKey] = useState<number>(0);

    const [chatTarget, setChatTarget] = useState<{ agentId: string; convId: string | null } | null>(
        null,
    );
    const onOpenChat = useCallback((agentId: string, convId: string | null) => {
        setChatTarget({ agentId, convId });
    }, []);
    const onConversationDeleted = useCallback((convId: string) => {
        setChatTarget((prev) =>
            prev && prev.convId === convId ? { agentId: prev.agentId, convId: null } : prev,
        );
    }, []);

    const debugGateway = useMemo<DebugGatewayNode | null>(
        () => graph.nodes.find((n): n is DebugGatewayNode => n.type === 'debug_gateway') ?? null,
        [graph.nodes],
    );

    const activeChat = useMemo(() => {
        if (!chatTarget || !currentGraphId || graph.kind !== 'l2') return null;
        const agent = graph.nodes.find((n) => n.id === chatTarget.agentId);
        if (!agent) return null;
        const sidecarChannelId = sidecarChannelIdFor(graph, chatTarget.agentId);
        if (!sidecarChannelId) return null;
        const agentName =
            'display_name' in agent && typeof agent.display_name === 'string'
                ? agent.display_name
                : undefined;
        return {
            sidecarChannelId,
            agentId: chatTarget.agentId,
            convId: chatTarget.convId,
            ...(agentName ? { agentName } : {}),
        };
    }, [chatTarget, currentGraphId, graph]);

    const showWebchat = activeChat !== null && debugGateway === null;
    const showDebugPanel = debugGateway !== null && currentGraphId !== null;
    const showChat = showWebchat || showDebugPanel;
    const observabilityEvents = useMemo<ObservabilityEvent[]>(
        () => events.filter((ev): ev is ObservabilityEvent => !isDispatchEvent(ev)),
        [events],
    );

    useEffect(() => {
        let cancelled = false;
        hydrated.current = false;
        void (async () => {
            try {
                if (graphId) {
                    const fetched = await client.getGraph(graphId);
                    if (cancelled) return;
                    if (fetched) {
                        replaceGraph(fetched.graph);
                        storeCurrentGraphId(fetched.id);
                        hydrated.current = true;
                        return;
                    }
                    setError(`Graph ${graphId} no longer exists.`);
                    replaceGraph(buildOfflineFallbackGraph());
                    hydrated.current = true;
                    return;
                }
                const initial = await bootstrapGraph(client);
                if (cancelled) return;
                replaceGraph(initial.graph);
                hydrated.current = true;
            } catch (err) {
                if (cancelled) return;
                replaceGraph(buildOfflineFallbackGraph());
                hydrated.current = true;
                setError(
                    `Could not load saved graphs (${err instanceof Error ? err.message : String(err)}). Editing locally — changes will not be persisted.`,
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, graphId, replaceGraph, setError]);

    useEffect(
        () => subscribeObservabilityStream({ client, appendEvents, clearEvents }),
        [client, appendEvents, clearEvents],
    );

    useEffect(() => subscribeTraversalStream({ client }), [client]);

    useEffect(() => {
        if (!currentGraphId || graph.kind !== 'l1') {
            setParentContext(null);
            return;
        }
        let cancelled = false;
        void client
            .getParentContext(currentGraphId)
            .then((result) => {
                if (cancelled) return;
                setParentContext({ nodes: result.nodes, edges: result.edges });
                if (result.parentGraphId) {
                    void client.activateGraph(result.parentGraphId).catch(() => {
                        /* best-effort — the L2 may simply not be loadable yet */
                    });
                }
            })
            .catch(() => {
                if (!cancelled) setParentContext(null);
            });
        return () => {
            cancelled = true;
        };
    }, [client, currentGraphId, graph.kind]);

    useEffect(() => {
        if (!currentGraphId || lockState !== 'running' || graph.kind !== 'l2') {
            setRunningNodes(new Set<string>());
            setNodeRuntimeStates([]);
            return;
        }
        const stream = client.graphStatusStream(currentGraphId, (ev) => {
            setRunningNodes(new Set(ev.running.map((s) => s.nodeId)));
            setNodeRuntimeStates(ev.running);
        });
        return () => {
            stream.close();
            setRunningNodes(new Set<string>());
            setNodeRuntimeStates([]);
        };
    }, [client, currentGraphId, lockState, graph.kind]);

    const [permissionQueue, setPermissionQueue] = useState<PermissionDecisionRequest[]>([]);
    const permissionNodeIds = useMemo(() => {
        if (graph.kind !== 'l1') return '';
        return graph.nodes
            .filter((n): n is PermissionNode => n.type === 'permission')
            .map((n) => n.id)
            .sort((a, b) => a.localeCompare(b))
            .join(',');
    }, [graph.kind, graph.nodes]);
    useEffect(() => {
        if (!currentGraphId || !permissionNodeIds) return;
        const ids = permissionNodeIds.split(',').filter((s) => s.length > 0);
        const sources: StreamSubscription[] = ids.map((id) =>
            client.permissionGateStream(currentGraphId, id, (req) => {
                setPermissionQueue((prev) => {
                    if (prev.some((p) => p.callId === req.callId)) return prev;
                    return [...prev, req];
                });
            }),
        );
        return () => {
            for (const s of sources) s.close();
            // Don't clear the queue here. If the effect runs again (rare — only
            // on add/remove), the new SSE's seed re-delivers any still-pending
            // requests and dedupe-by-callId keeps things consistent.
        };
    }, [client, currentGraphId, permissionNodeIds]);

    const onPermissionDecide = useCallback(
        (req: PermissionDecisionRequest, decision: PermissionDecision) => {
            if (!currentGraphId) return;
            setPermissionQueue((prev) => prev.filter((p) => p.callId !== req.callId));
            void client
                .permissionGateDecide(currentGraphId, req.permissionNodeId, req.callId, decision)
                .catch((err) => {
                    setError(
                        `Permission decision failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                });
        },
        [client, currentGraphId, setError],
    );

    useEffect(() => {
        if (!hydrated.current) return;
        if (!currentGraphId) return;
        if (graph === lastSavedGraph) return;
        if (graph.system === true) return;
        const id = currentGraphId;
        const snapshot = graph;
        const handle = setTimeout(() => {
            void client
                .updateGraph(id, snapshot)
                .then((res) => {
                    if (res === null) {
                        storeCurrentGraphId(null);
                        return;
                    }
                    markGraphSaved(snapshot);
                })
                .catch((err) => {
                    setError(
                        `Auto-save failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                });
        }, AUTO_SAVE_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [client, currentGraphId, graph, lastSavedGraph, markGraphSaved, setError]);

    const [triggerRunsNodeId, setTriggerRunsNodeId] = useState<string | null>(null);

    const [askCallsNodeId, setAskCallsNodeId] = useState<string | null>(null);

    const onNodeDoubleClick = useCallback(
        (id: string) => {
            const node = graph.nodes.find((n) => n.id === id);
            if (!node || !currentGraphId) return;
            if (node.type === 'trigger') {
                setTriggerRunsNodeId(node.id);
                return;
            }
            const refId = refIdOf(node);
            if (!refId) return;
            void drillInto(refId);
        },
        [currentGraphId, drillInto, graph],
    );

    const triggerRunsNode = useMemo(() => {
        if (!triggerRunsNodeId) return null;
        const found = graph.nodes.find((n) => n.id === triggerRunsNodeId);
        return found && found.type === 'trigger' ? found : null;
    }, [graph.nodes, triggerRunsNodeId]);

    const askCallsNode = useMemo(() => {
        if (!askCallsNodeId) return null;
        const found = graph.nodes.find((n) => n.id === askCallsNodeId);
        return found && found.type === 'native_agent' ? found : null;
    }, [graph.nodes, askCallsNodeId]);

    const onReset = async () => {
        if (graph.system === true) {
            setError("Can't reset a runner-owned starter template.");
            return;
        }
        if (
            typeof window !== 'undefined' &&
            currentGraphId &&
            !window.confirm(
                'Reset the current graph to the sample? This overwrites the saved graph.',
            )
        ) {
            return;
        }
        try {
            replaceGraph(await buildResetSampleGraph(client, graph.kind));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const pickerName = graph.name && graph.name.length > 0 ? graph.name : 'Untitled';

    const onLibraryDrop = useCallback(
        async (templateId: string, position: Position) => {
            try {
                const fetched = await client.getGraph(templateId);
                if (!fetched) {
                    setError('Library entry no longer exists.');
                    return;
                }
                if (fetched.graph.fragment === true && fetched.graph.kind !== graph.kind) {
                    setError(
                        `A ${fetched.graph.kind} preset can only drop on a ${fetched.graph.kind} canvas, not a ${graph.kind} canvas.`,
                    );
                    return;
                }
                const fragmentNodes = fetched.graph.nodes;
                if (fragmentNodes.length === 1 && isPresetSavable(fragmentNodes[0]!)) {
                    const lone = fragmentNodes[0]!;
                    const allowedTypes = paletteKindsForGraphKind(graph.kind);
                    if (!(allowedTypes as ReadonlySet<string>).has(lone.type)) {
                        setError(`A ${lone.type} preset can't drop on a ${graph.kind} canvas.`);
                        return;
                    }
                    if (
                        (lone.type === 'gateway' || lone.type === 'output') &&
                        graph.nodes.some((n) => n.type === lone.type)
                    ) {
                        setError(`This canvas already has a ${lone.type}.`);
                        return;
                    }
                    const node: Node = {
                        ...lone,
                        id: nextNodeId(lone.type),
                        position,
                    } as Node;
                    addNode(node);
                    setSelectedNodeId(node.id);
                    return;
                }

                if (fragmentNodes.length > 1 && fetched.graph.kind === graph.kind) {
                    if (!currentGraphId) {
                        setError('Drop the preset on a saved canvas first.');
                        return;
                    }
                    const offsetNodes = fragmentNodes.map((n) => ({
                        ...n,
                        position: { x: n.position.x + position.x, y: n.position.y + position.y },
                    }));
                    const result = await client.cloneSubtree(currentGraphId, {
                        nodes: offsetNodes,
                        edges: fetched.graph.edges,
                    });
                    applyOpsResult(result.graph, result.remap);
                    return;
                }

                if (!currentGraphId) {
                    setError('Drop the agent on a saved canvas first.');
                    return;
                }
                const instantiated = await client.instantiateGraph(templateId);
                const savedKind = instantiated.graph.kind as SavedRefKind;
                const allowed = savedRefKindsForGraphKind(graph.kind);
                if (!allowed.has(savedKind)) {
                    setError(
                        `Cannot drop a ${instantiated.graph.kind} library entry on a ${graph.kind} canvas.`,
                    );
                    return;
                }
                const node = buildSavedRefNode(
                    savedKind,
                    instantiated.id,
                    instantiated.graph.name ?? '',
                    position,
                    templateId,
                    instantiated.graph.description,
                );
                addNode(node);
                setSelectedNodeId(node.id);
                const { id: _optId, type: _optType, position: _optPos, ...config } = node;
                const placeholder = `$opt-${node.id}`;
                const result = await client.applyGraphOps(currentGraphId, [
                    {
                        op: 'add_node',
                        kind: node.type,
                        position,
                        config,
                        as: placeholder,
                    },
                ]);
                const translated: Record<string, string> = {
                    ...result.remap,
                    [node.id]: result.remap[placeholder] ?? node.id,
                };
                applyOpsResult(result.graph, translated);
                setSelectedNodeId(translated[node.id] ?? node.id);
            } catch (err) {
                setError(
                    `Library drop failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
        [
            addNode,
            applyOpsResult,
            client,
            currentGraphId,
            graph.kind,
            graph.nodes,
            setError,
            setSelectedNodeId,
        ],
    );

    const onSavePreset = useCallback(
        async (nodeId: string) => {
            const target = graph.nodes.find((n) => n.id === nodeId);
            if (!target) return;
            if (!isPresetSavable(target)) {
                setError("That node can't be saved as a preset.");
                return;
            }
            const defaultName = suggestPresetName(target);
            const raw = window.prompt('Save preset — name?', defaultName);
            const name = raw?.trim();
            if (!name) return;
            try {
                const recentered: Node = {
                    ...target,
                    position: { x: 0, y: 0 },
                } as Node;
                await client.createGraph({
                    kind: graph.kind,
                    nodes: [recentered],
                    edges: [],
                    library: true,
                    name,
                });
                setLibraryRefreshKey((n) => n + 1);
            } catch (err) {
                setError(`Save preset failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        [client, graph.kind, graph.nodes, setError],
    );

    const onSaveSelectionPreset = useCallback(
        async (fragment: Fragment & { name: string }) => {
            try {
                await client.saveFragment(fragment);
                setLibraryRefreshKey((n) => n + 1);
            } catch (err) {
                setError(`Save preset failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        [client, setError],
    );

    const onPiAgentDrop = useCallback(
        async (position: Position) => {
            if (!currentGraphId) {
                setError('Drop the agent on a saved canvas first.');
                return;
            }
            try {
                const seed = await createCliInvocationGraph(client, {
                    defaultName: 'pi config',
                    targetDisplayName: 'pi',
                });
                const placeholderId = nextNodeId('pi_agent');
                const optimistic: PiAgentNode = {
                    id: placeholderId,
                    type: 'pi_agent',
                    position,
                    session_mode: 'session-aware',
                    ref_id: seed.id,
                };
                addNode(optimistic);
                setSelectedNodeId(optimistic.id);
                const placeholder = `$opt-${placeholderId}`;
                const result = await client.applyGraphOps(currentGraphId, [
                    {
                        op: 'add_node',
                        kind: 'pi_agent',
                        position,
                        config: { ref_id: seed.id, session_mode: 'session-aware' },
                        as: placeholder,
                    },
                ]);
                const translated: Record<string, string> = {
                    ...result.remap,
                    [placeholderId]: result.remap[placeholder] ?? placeholderId,
                };
                applyOpsResult(result.graph, translated);
            } catch (err) {
                setError(
                    `Could not create PiAgent config graph: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
        [addNode, applyOpsResult, client, currentGraphId, setError, setSelectedNodeId],
    );

    return (
        <div className="grid h-screen w-screen grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_240px] bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-baseline gap-4">
                    <Link
                        href="/"
                        className="text-sm font-semibold tracking-wide text-zinc-900 transition hover:text-indigo-700 dark:text-white dark:hover:text-indigo-300"
                    >
                        Fabritorio
                    </Link>
                    {currentGraphId ? (
                        <Breadcrumbs currentId={currentGraphId} />
                    ) : (
                        <span className="text-xs text-zinc-500 dark:text-zinc-500">
                            playground · drag from the palette, connect handles, edit in the
                            inspector
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        state:{' '}
                        <span className="font-mono text-zinc-800 dark:text-zinc-200">
                            {runState}
                        </span>
                    </span>
                    <LockBadge state={lockState} />
                    <div
                        className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                        title={
                            currentGraphId
                                ? `Saved · auto-saving to ${currentGraphId.slice(0, 8)}…`
                                : 'Unsaved — open or create a graph from the home screen'
                        }
                    >
                        <span className="max-w-[16rem] truncate">{pickerName}</span>
                        <span
                            className={`rounded px-1 text-[10px] font-medium uppercase tracking-wider ${
                                graph.kind === 'l1'
                                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200'
                                    : graph.kind === 'toolpack'
                                      ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/20 dark:text-yellow-200'
                                      : graph.kind === 'skillpack'
                                        ? 'bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200'
                                        : graph.kind === 'handler'
                                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'
                                          : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'
                            }`}
                        >
                            {graph.kind}
                        </span>
                        {!currentGraphId && (
                            <span className="rounded bg-amber-200 px-1 text-[10px] font-medium uppercase text-amber-900 dark:bg-amber-700/40 dark:text-amber-200">
                                unsaved
                            </span>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onReset}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                        Reset graph
                    </button>
                    <ThemeToggle />
                </div>
            </header>
            <main
                className={`relative grid min-h-0 grid-rows-1 ${
                    showChat ? 'grid-cols-[200px_1fr_320px_280px]' : 'grid-cols-[200px_1fr_280px]'
                }`}
            >
                <Palette graphKind={graph.kind} libraryRefreshKey={libraryRefreshKey} />
                <div className="relative">
                    <Canvas
                        graphKind={graph.kind}
                        graphId={currentGraphId ?? null}
                        nodes={graph.nodes}
                        edges={graph.edges}
                        selectedNodeId={selectedNodeId}
                        setSelectedNodeId={setSelectedNodeId}
                        addNode={addNode}
                        addEdge={addEdge}
                        removeNode={removeNode}
                        removeEdge={removeEdge}
                        updateNodePosition={updateNodePosition}
                        updateNodeConfig={updateNodeConfig}
                        replaceGraph={replaceGraph}
                        cloneSubtree={cloneSubtreeRef}
                        applyOps={applyGraphOpsRef}
                        onOpsApplied={applyOpsResult}
                        setError={setError}
                        onNodeDoubleClick={onNodeDoubleClick}
                        onPiAgentDrop={onPiAgentDrop}
                        onLibraryDrop={onLibraryDrop}
                        onSaveSelectionPreset={onSaveSelectionPreset}
                        events={observabilityEvents}
                        runningNodes={runningNodes}
                        nodeRuntimeStates={nodeRuntimeStates}
                        {...(parentContext ? { parentContext } : {})}
                    />
                    {error && (
                        <div className="absolute bottom-3 left-3 max-w-md rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 shadow-sm dark:border-rose-600/60 dark:bg-rose-950/70 dark:text-rose-200">
                            {error}
                        </div>
                    )}
                </div>
                {showDebugPanel && currentGraphId && debugGateway && (
                    <DebugGatewayPanel
                        graphId={currentGraphId}
                        debugNodeId={debugGateway.id}
                        {...(debugGateway.display_name
                            ? { displayName: debugGateway.display_name }
                            : {})}
                        client={client}
                        onLockStateChange={setLockState}
                    />
                )}
                {showWebchat && currentGraphId && activeChat && (
                    <WebchatPanel
                        key={`${activeChat.agentId}:${activeChat.convId ?? 'new'}`}
                        graphId={currentGraphId}
                        sidecarChannelId={activeChat.sidecarChannelId}
                        agentId={activeChat.agentId}
                        convId={activeChat.convId}
                        {...(activeChat.agentName ? { agentName: activeChat.agentName } : {})}
                        client={client}
                        onLockStateChange={setLockState}
                    />
                )}
                <Inspector
                    graphKind={graph.kind}
                    selectedNodeId={selectedNodeId}
                    nodes={graph.nodes}
                    edges={graph.edges}
                    updateNodeConfig={updateNodeConfig}
                    updateEdge={updateEdge}
                    removeNode={removeNode}
                    client={client}
                    currentGraphId={currentGraphId ?? null}
                    runningNodes={runningNodes}
                    {...(parentContext ? { ghostNodes: parentContext.nodes } : {})}
                    onSelectNode={setSelectedNodeId}
                    onOpenTriggerRuns={setTriggerRunsNodeId}
                    onOpenAgentCalls={setAskCallsNodeId}
                    onSavePreset={onSavePreset}
                    onOpenChat={onOpenChat}
                    onConversationDeleted={onConversationDeleted}
                />
            </main>
            <LogViewer />
            <PermissionPromptModal queue={permissionQueue} onDecide={onPermissionDecide} />
            {currentGraphId && triggerRunsNode && (
                <TriggerRunsModal
                    graphId={currentGraphId}
                    nodeId={triggerRunsNode.id}
                    {...(triggerRunsNode.display_name
                        ? { nodeName: triggerRunsNode.display_name }
                        : {})}
                    client={client}
                    open={triggerRunsNodeId !== null}
                    onClose={() => setTriggerRunsNodeId(null)}
                />
            )}
            {currentGraphId && askCallsNode && (
                <AskCallsModal
                    graphId={currentGraphId}
                    nodeId={askCallsNode.id}
                    {...(askCallsNode.display_name ? { nodeName: askCallsNode.display_name } : {})}
                    client={client}
                    open={askCallsNodeId !== null}
                    onClose={() => setAskCallsNodeId(null)}
                />
            )}
        </div>
    );
}

function LockBadge({ state }: { state: LockState }) {
    return (
        <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                state === 'running'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'
                    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
            title={
                state === 'running'
                    ? 'Runner has the graph loaded — channel/agent bindings are active'
                    : 'Runner is not currently bound to this graph'
            }
        >
            {state === 'running' ? 'running' : 'idle'}
        </span>
    );
}

function refIdOf(node: Node): string | undefined {
    if (node.type === 'native_agent') {
        return node.l1_graph_id || undefined;
    }
    if ('ref_id' in node && typeof node.ref_id === 'string') {
        return node.ref_id || undefined;
    }
    return undefined;
}
