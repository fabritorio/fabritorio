'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ReactFlow,
    ReactFlowProvider,
    Background,
    BackgroundVariant,
    Controls,
    Panel,
    useReactFlow,
    type Connection,
    type Node as FlowNode,
    type Edge as FlowEdge,
    type NodeChange,
    type EdgeChange,
} from '@xyflow/react';
import type {
    ActiveAsk,
    Edge,
    Graph,
    GraphKind,
    Node,
    NodeRuntimeStateWire,
    ObservabilityEvent,
    Position,
} from '@fabritorio/types';
import { ModelNode } from './nodes/ModelNode';
import { ModelRouterNode } from './nodes/ModelRouterNode';
import { GatewayNode } from './nodes/GatewayNode';
import { OutputNode } from './nodes/OutputNode';
import { SkillNode } from './nodes/SkillNode';
import { SkillPackNode } from './nodes/SkillPackNode';
import { ToolNode } from './nodes/ToolNode';
import { ToolPackNode } from './nodes/ToolPackNode';
import { WorkspaceNode } from './nodes/WorkspaceNode';
import { SecretsNode } from './nodes/SecretsNode';
import { HandlerNode } from './nodes/HandlerNode';
import { ChannelNode } from './nodes/ChannelNode';
import { TriggerNode } from './nodes/TriggerNode';
import { NativeAgentNode } from './nodes/NativeAgentNode';
import { CliAgentNode } from './nodes/CliAgentNode';
import { PiAgentNode } from './nodes/PiAgentNode';
import { MemoryNode } from './nodes/MemoryNode';
import { HandlerInputNode } from './nodes/HandlerInputNode';
import { HandlerOutputNode } from './nodes/HandlerOutputNode';
import { PromptBuilderNode } from './nodes/PromptBuilderNode';
import { ModelCallNode } from './nodes/ModelCallNode';
import { EvaluatorNode } from './nodes/EvaluatorNode';
import { ToolExecNode } from './nodes/ToolExecNode';
import { CliInvocationTargetNode } from './nodes/CliInvocationTargetNode';
import { DebugGatewayNode } from './nodes/DebugGatewayNode';
import { DebugProbeNode } from './nodes/DebugProbeNode';
import { PermissionNode } from './nodes/PermissionNode';
import { CheckpointNode } from './nodes/CheckpointNode';
import { FlowEdge as FabritorioEdge } from './edges/FlowEdge';
import { deliverToEdge, subscribeTraversals } from '@/lib/traversal-bus';
import { useNodeLiveness } from '@/lib/useNodeLiveness';
import { useNodeTransients } from '@/lib/useNodeTransients';
import { DRAG_MIME, LIBRARY_DRAG_MIME } from './Palette';
import { buildNode, paletteKindsForGraphKind, type PaletteKind } from '@/lib/node-factory';
import { computeActiveEdges, computeNodeStates, type NodeStateMap } from '@/lib/node-state';
import {
    canConnect,
    canConnectCliInvocation,
    canConnectHandler,
    canConnectL2,
    canConnectSkillPack,
    canConnectToolPack,
    probeAttachCheck,
    resolvePortsL1,
} from '@/lib/edge-validation';
import { buildPastedGraph, serializeFragment, type CloneSubtreeFn } from '@/lib/canvas-clipboard';
import { isSystemChannel } from '@/lib/webchat';
import { extractFragment, type Fragment } from '@/lib/subgraph';
import {
    GHOST_PREFIX,
    loadGhostPositions,
    loadGhostsHidden,
    saveGhostPositions,
    saveGhostsHidden,
    stripGhostPrefix,
    type GhostPositions,
} from '@/lib/ghost';
import type { GraphOp } from '@/lib/runner-client';
import {
    OPTIMISTIC_EDGE_ERROR_CLASS,
    OPTIMISTIC_EDGE_PENDING_CLASS,
    OPTIMISTIC_ERROR_DISSOLVE_MS,
    OPTIMISTIC_NODE_ERROR_CLASS,
    OPTIMISTIC_NODE_PENDING_CLASS,
    useOptimisticGhosts,
} from '@/lib/optimistic-ghost';

const nodeTypes = {
    model: ModelNode,
    model_router: ModelRouterNode,
    gateway: GatewayNode,
    output: OutputNode,
    skill: SkillNode,
    skill_pack: SkillPackNode,
    tool: ToolNode,
    tool_pack: ToolPackNode,
    workspace: WorkspaceNode,
    secrets: SecretsNode,
    handler: HandlerNode,
    channel: ChannelNode,
    trigger: TriggerNode,
    native_agent: NativeAgentNode,
    cli_agent: CliAgentNode,
    pi_agent: PiAgentNode,
    memory: MemoryNode,
    handler_input: HandlerInputNode,
    handler_output: HandlerOutputNode,
    prompt_builder: PromptBuilderNode,
    model_call: ModelCallNode,
    evaluator: EvaluatorNode,
    tool_exec: ToolExecNode,
    cli_invocation_target: CliInvocationTargetNode,
    debug_gateway: DebugGatewayNode,
    debug_probe: DebugProbeNode,
    permission: PermissionNode,
    checkpoint: CheckpointNode,
};

const edgeTypes = {
    fabritorio: FabritorioEdge,
};

interface Props {
    graphKind: GraphKind;
    nodes: ReadonlyArray<Node>;
    edges: ReadonlyArray<Edge>;
    selectedNodeId: string | null;
    setSelectedNodeId: (id: string | null) => void;
    addNode: (node: Node) => void;
    addEdge: (edge: Edge) => void;
    removeNode: (id: string) => void;
    removeEdge: (id: string) => void;
    applyOps?: (
        ops: GraphOp[],
    ) => Promise<{ graph: Graph; remap: Record<string, string>; results: unknown[] }>;
    onOpsApplied?: (graph: Graph, remap: Record<string, string>) => void;
    updateNodePosition: (id: string, position: Position) => void;
    updateNodeConfig?: (id: string, patch: Partial<Node>) => void;
    replaceGraph?: (graph: Graph) => void;
    cloneSubtree?: CloneSubtreeFn;
    setError?: (error: string | null) => void;
    onNodeDoubleClick?: (id: string, type: string) => void;
    onPiAgentDrop?: (position: Position) => Promise<void> | void;
    onLibraryDrop?: (templateId: string, position: Position) => Promise<void> | void;
    onSaveSelectionPreset?: (fragment: Fragment & { name: string }) => Promise<void> | void;
    events?: ReadonlyArray<ObservabilityEvent>;
    runningNodes?: ReadonlySet<string>;
    nodeRuntimeStates?: ReadonlyArray<NodeRuntimeStateWire>;
    parentContext?: ParentContext;
    graphId?: string | null;
}

export interface ParentContext {
    nodes: ReadonlyArray<Node>;
    edges: ReadonlyArray<Edge>;
}

const memoryClipboardRef: { current: string | null } = { current: null };

const EMPTY_ASKS_MAP: ReadonlyMap<string, ReadonlyArray<ActiveAsk>> = new Map();
const EMPTY_EDGE_MAP: ReadonlyMap<string, string> = new Map();
const EMPTY_EDGE_ID_SET: ReadonlySet<string> = new Set();

function edgeKey(sourceNodeId: string, targetNodeId: string): string {
    return `${sourceNodeId}|${targetNodeId}`;
}

function CanvasInner(props: Props) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const rf = useReactFlow();
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set<string>());
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    selectedNodeIdsRef.current = selectedNodeIds;

    const {
        api: optimisticApi,
        nodes: optimisticNodePhases,
        edges: optimisticEdgePhases,
    } = useOptimisticGhosts();
    const opsEnabled = Boolean(props.applyOps && props.onOpsApplied);

    const fireOps = useCallback(
        (
            ops: GraphOp[],
            optimistic: { nodes: ReadonlyArray<string>; edges: ReadonlyArray<string> } = {
                nodes: [],
                edges: [],
            },
        ): void => {
            if (!props.applyOps || !props.onOpsApplied) return;
            for (const id of optimistic.nodes) optimisticApi.markNodePending(id);
            for (const id of optimistic.edges) optimisticApi.markEdgePending(id);
            const applyOps = props.applyOps;
            const onOpsApplied = props.onOpsApplied;
            void applyOps(ops)
                .then((res) => {
                    for (const id of optimistic.nodes) optimisticApi.settleNode(id);
                    for (const id of optimistic.edges) optimisticApi.settleEdge(id);
                    const translated: Record<string, string> = { ...res.remap };
                    for (const [k, v] of Object.entries(res.remap)) {
                        if (k.startsWith('$opt-')) {
                            translated[k.slice('$opt-'.length)] = v;
                        }
                    }
                    onOpsApplied(res.graph, translated);
                })
                .catch((err) => {
                    for (const id of optimistic.nodes) optimisticApi.failNode(id);
                    for (const id of optimistic.edges) optimisticApi.failEdge(id);
                    if (props.setError) {
                        const msg = err instanceof Error ? err.message : String(err);
                        props.setError(`Op failed: ${msg}`);
                    }
                    setTimeout(() => {
                        for (const id of optimistic.nodes) {
                            optimisticApi.settleNode(id);
                            props.removeNode(id);
                        }
                        for (const id of optimistic.edges) {
                            optimisticApi.settleEdge(id);
                            props.removeEdge(id);
                        }
                    }, OPTIMISTIC_ERROR_DISSOLVE_MS);
                });
        },
        [optimisticApi, props],
    );

    const nodeStates = useMemo<NodeStateMap>(() => {
        const base = computeNodeStates({ nodes: props.nodes }, props.events ?? []);
        if (!props.runningNodes || props.runningNodes.size === 0) return base;
        const next: NodeStateMap = { ...base };
        for (const id of props.runningNodes) next[id] = 'running';
        return next;
    }, [props.nodes, props.events, props.runningNodes]);

    const activeEdges = useMemo<Set<string>>(() => {
        if (props.graphKind !== 'l1' && props.graphKind !== 'l2') return new Set<string>();
        return computeActiveEdges({ edges: props.edges }, nodeStates);
    }, [props.graphKind, props.edges, nodeStates]);

    const activeAsksByNode = useMemo<ReadonlyMap<string, ReadonlyArray<ActiveAsk>>>(() => {
        const states = props.nodeRuntimeStates;
        if (!states || states.length === 0) return EMPTY_ASKS_MAP;
        const out = new Map<string, ReadonlyArray<ActiveAsk>>();
        for (const s of states) {
            if (s.phase === 'asking' && s.activeAsks.length > 0) {
                out.set(s.nodeId, s.activeAsks);
            }
        }
        return out;
    }, [props.nodeRuntimeStates]);

    const nodeDisplayNames = useMemo<ReadonlyMap<string, string>>(() => {
        const out = new Map<string, string>();
        for (const n of props.nodes) {
            const label =
                'display_name' in n &&
                typeof n.display_name === 'string' &&
                n.display_name.length > 0
                    ? n.display_name
                    : n.id;
            out.set(n.id, label);
        }
        return out;
    }, [props.nodes]);

    const askEdgeIdByPair = useMemo<ReadonlyMap<string, string>>(() => {
        if (activeAsksByNode === EMPTY_ASKS_MAP) return EMPTY_EDGE_MAP;
        const out = new Map<string, string>();
        for (const e of props.edges) {
            out.set(edgeKey(e.source.node_id, e.target.node_id), e.id);
        }
        return out;
    }, [props.edges, activeAsksByNode]);

    const askingEdgeIds = useMemo<ReadonlySet<string>>(() => {
        if (activeAsksByNode === EMPTY_ASKS_MAP) return EMPTY_EDGE_ID_SET;
        const out = new Set<string>();
        for (const [callerId, asks] of activeAsksByNode) {
            for (const a of asks) {
                const id = askEdgeIdByPair.get(edgeKey(callerId, a.targetNodeId));
                if (id) out.add(id);
            }
        }
        return out;
    }, [activeAsksByNode, askEdgeIdByPair]);

    const incidentEdges = useMemo<Set<string>>(() => {
        if (!props.selectedNodeId) return new Set<string>();
        const ids = new Set<string>();
        for (const e of props.edges) {
            if (
                e.source.node_id === props.selectedNodeId ||
                e.target.node_id === props.selectedNodeId
            ) {
                ids.add(e.id);
            }
        }
        return ids;
    }, [props.edges, props.selectedNodeId]);

    useEffect(() => {
        const primary = props.selectedNodeId;
        if (primary && !selectedNodeIdsRef.current.has(primary)) {
            setSelectedNodeIds(new Set([primary]));
        }
    }, [props.selectedNodeId]);

    const [ghostPositions, setGhostPositions] = useState<GhostPositions>({});
    const [ghostsHidden, setGhostsHiddenState] = useState<boolean>(false);
    useEffect(() => {
        if (props.graphKind !== 'l1' || !props.graphId) {
            setGhostPositions({});
            setGhostsHiddenState(false);
            return;
        }
        setGhostPositions(loadGhostPositions(props.graphId));
        setGhostsHiddenState(loadGhostsHidden(props.graphId));
    }, [props.graphKind, props.graphId]);

    const ghostNodes = useMemo<Node[]>(() => {
        if (props.graphKind !== 'l1') return [];
        if (!props.parentContext) return [];
        if (ghostsHidden) return [];
        return props.parentContext.nodes
            .filter((n) => !isSystemChannel(n))
            .map((n) => {
                const override = ghostPositions[n.id];
                const position = override ?? {
                    x: -200 + ghostIndex(n, props.parentContext!.nodes) * 220,
                    y: -160,
                };
                return {
                    ...n,
                    id: `${GHOST_PREFIX}${n.id}`,
                    position,
                };
            });
    }, [props.graphKind, props.parentContext, ghostPositions, ghostsHidden]);

    const l1EntryNodeId = useMemo<string | null>(() => {
        if (props.graphKind !== 'l1') return null;
        const handler = props.nodes.find((n) => n.type === 'handler');
        if (handler) return handler.id;
        const gateway = props.nodes.find((n) => n.type === 'gateway');
        if (gateway) return gateway.id;
        return null;
    }, [props.graphKind, props.nodes]);

    const liveEvents = useMemo(() => props.events ?? [], [props.events]);
    const { phaseLabels } = useNodeLiveness({ wrapperRef, nodes: props.nodes, events: liveEvents });

    const { byNode: transients } = useNodeTransients({ nodes: props.nodes, events: liveEvents });

    const systemChannelIds = useMemo<ReadonlySet<string>>(() => {
        const out = new Set<string>();
        for (const n of props.nodes) {
            if (isSystemChannel(n)) out.add(n.id);
        }
        return out;
    }, [props.nodes]);

    const isSystemEdge = useCallback(
        (e: Edge): boolean =>
            systemChannelIds.has(e.source.node_id) || systemChannelIds.has(e.target.node_id),
        [systemChannelIds],
    );

    const flowNodes = useMemo<FlowNode[]>(() => {
        const real = props.nodes
            .filter((n) => !systemChannelIds.has(n.id))
            .map<FlowNode>((n) => {
                const phase = optimisticNodePhases.get(n.id) ?? null;
                const optimisticClass =
                    phase === 'pending'
                        ? OPTIMISTIC_NODE_PENDING_CLASS
                        : phase === 'error'
                          ? OPTIMISTIC_NODE_ERROR_CLASS
                          : undefined;
                const asks = activeAsksByNode.get(n.id);
                const phaseLabel = phaseLabels.get(n.id);
                const tr = transients.get(n.id);
                return {
                    id: n.id,
                    type: n.type,
                    position: n.position,
                    data: {
                        ...n,
                        __state: nodeStates[n.id] ?? 'idle',
                        ...(asks ? { __activeAsks: asks, __askTargetNames: nodeDisplayNames } : {}),
                        ...(phaseLabel ? { __phaseLabel: phaseLabel } : {}),
                        ...(tr?.toolArgPreview ? { __toolArgPreview: tr.toolArgPreview } : {}),
                        ...(tr && tr.toolExitOk !== undefined
                            ? { __toolExitOk: tr.toolExitOk }
                            : {}),
                        ...(tr?.routerTrying ? { __routerTrying: tr.routerTrying } : {}),
                        ...(tr?.fellThroughReason
                            ? { __fellThroughReason: tr.fellThroughReason }
                            : {}),
                        ...(tr?.stoppedReason ? { __stoppedReason: tr.stoppedReason } : {}),
                        ...(tr?.iter ? { __iter: tr.iter } : {}),
                    },
                    selected: selectedNodeIds.has(n.id),
                    ...(optimisticClass ? { className: optimisticClass } : {}),
                };
            });
        if (ghostNodes.length === 0) return real;
        const ghosts = ghostNodes.map<FlowNode>((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: { ...n, __state: 'idle' },
            selected: selectedNodeIds.has(n.id),
            draggable: true,
            selectable: true,
            deletable: false,
            connectable: false,
            className: 'fabritorio-ghost-node',
        }));
        return [...real, ...ghosts];
    }, [
        props.nodes,
        selectedNodeIds,
        nodeStates,
        ghostNodes,
        optimisticNodePhases,
        activeAsksByNode,
        nodeDisplayNames,
        phaseLabels,
        transients,
        systemChannelIds,
    ]);

    const flowEdges = useMemo<FlowEdge[]>(() => {
        const ghostNodeIds = new Set(ghostNodes.map((n) => n.id));
        const ghostFlowEdges: FlowEdge[] =
            props.graphKind === 'l1' && props.parentContext && l1EntryNodeId
                ? props.parentContext.edges
                      .map<FlowEdge | null>((e) => {
                          const srcGhostId = `${GHOST_PREFIX}${e.source.node_id}`;
                          const tgtGhostId = `${GHOST_PREFIX}${e.target.node_id}`;
                          const srcIsGhost = ghostNodeIds.has(srcGhostId);
                          const tgtIsGhost = ghostNodeIds.has(tgtGhostId);
                          if (srcIsGhost === tgtIsGhost) return null;
                          const source = srcIsGhost ? srcGhostId : l1EntryNodeId;
                          const target = tgtIsGhost ? tgtGhostId : l1EntryNodeId;
                          return {
                              id: `${GHOST_PREFIX}${e.id}`,
                              source,
                              target,
                              animated: false,
                              selected: false,
                              deletable: false,
                              selectable: false,
                              focusable: false,
                              interactionWidth: 0,
                              className: 'fabritorio-ghost-edge',
                          };
                      })
                      .filter((e): e is FlowEdge => e !== null)
                : [];
        const nodeKindById = new Map<string, string>();
        for (const n of props.nodes) nodeKindById.set(n.id, n.type);
        const real = props.edges
            .filter((e) => !isSystemEdge(e))
            .map<FlowEdge>((e) => {
                const active = activeEdges.has(e.id);
                const selected = e.id === selectedEdgeId || incidentEdges.has(e.id);
                const srcKind = nodeKindById.get(e.source.node_id);
                const kindSuffix =
                    srcKind === 'channel' || srcKind === 'gateway'
                        ? 'channel'
                        : srcKind === 'tool' || srcKind === 'tool_pack'
                          ? 'tool'
                          : 'default';
                const classes: string[] = [];
                if (active) {
                    classes.push('fabritorio-active-edge');
                    classes.push(`fabritorio-edge-kind-${kindSuffix}`);
                }
                const edgePhase = optimisticEdgePhases.get(e.id) ?? null;
                if (edgePhase === 'pending') classes.push(OPTIMISTIC_EDGE_PENDING_CLASS);
                else if (edgePhase === 'error') classes.push(OPTIMISTIC_EDGE_ERROR_CLASS);
                if (askingEdgeIds.has(e.id)) classes.push('fabritorio-asking-edge');
                return {
                    id: e.id,
                    type: 'fabritorio',
                    source: e.source.node_id,
                    target: e.target.node_id,
                    selected,
                    className: classes.join(' ') || undefined,
                    interactionWidth: 20,
                };
            });
        return [...real, ...ghostFlowEdges];
    }, [
        props.edges,
        props.nodes,
        props.graphKind,
        props.parentContext,
        activeEdges,
        selectedEdgeId,
        incidentEdges,
        ghostNodes,
        l1EntryNodeId,
        optimisticEdgePhases,
        askingEdgeIds,
        isSystemEdge,
    ]);

    const realEdgeIds = useMemo(
        () => new Set(props.edges.filter((e) => !isSystemEdge(e)).map((e) => e.id)),
        [props.edges, isSystemEdge],
    );
    const realEdgeIdsRef = useRef(realEdgeIds);
    realEdgeIdsRef.current = realEdgeIds;
    const graphIdRef = useRef(props.graphId ?? null);
    graphIdRef.current = props.graphId ?? null;

    useEffect(() => {
        return subscribeTraversals((ev) => {
            if (graphIdRef.current && ev.graphId !== graphIdRef.current) return;
            if (!realEdgeIdsRef.current.has(ev.edgeId)) return;
            deliverToEdge(ev);
        });
    }, []);

    const onNodesChange = useCallback(
        (changes: NodeChange[]) => {
            let ghostPositionsTouched: GhostPositions | null = null;
            const nextSelected = new Set(selectedNodeIdsRef.current);
            let lastSelectedId: string | null = null;
            let selectionTouched = false;
            for (const change of changes) {
                const isGhostChange = 'id' in change && change.id.startsWith(GHOST_PREFIX);
                if (isGhostChange) {
                    if (change.type === 'select') {
                        selectionTouched = true;
                        if (change.selected) {
                            nextSelected.add(change.id);
                            lastSelectedId = change.id;
                        } else {
                            nextSelected.delete(change.id);
                        }
                        continue;
                    }
                    if (change.type === 'position' && change.position && !change.dragging) {
                        const realId = stripGhostPrefix(change.id);
                        ghostPositionsTouched = {
                            ...(ghostPositionsTouched ?? ghostPositions),
                            [realId]: { x: change.position.x, y: change.position.y },
                        };
                    } else if (change.type === 'remove') {
                        if (nextSelected.delete(change.id)) {
                            selectionTouched = true;
                        }
                    }
                    continue;
                }
                if (change.type === 'position' && change.position && !change.dragging) {
                    props.updateNodePosition(change.id, change.position);
                } else if (change.type === 'remove') {
                    props.removeNode(change.id);
                    if (opsEnabled) {
                        fireOps([{ op: 'delete_node', id: change.id }], {
                            nodes: [],
                            edges: [],
                        });
                    }
                    if (nextSelected.delete(change.id)) {
                        selectionTouched = true;
                    }
                } else if (change.type === 'select') {
                    selectionTouched = true;
                    if (change.selected) {
                        nextSelected.add(change.id);
                        lastSelectedId = change.id;
                    } else {
                        nextSelected.delete(change.id);
                    }
                }
            }
            if (selectionTouched) {
                setSelectedNodeIds(nextSelected);
                if (lastSelectedId !== null) {
                    props.setSelectedNodeId(lastSelectedId);
                } else if (
                    props.selectedNodeId === null ||
                    !nextSelected.has(props.selectedNodeId)
                ) {
                    const next = nextSelected.values().next();
                    props.setSelectedNodeId(next.done ? null : next.value);
                }
            }
            if (ghostPositionsTouched) {
                const next = ghostPositionsTouched;
                setGhostPositions(next);
                if (props.graphId) {
                    saveGhostPositions(props.graphId, next);
                }
            }
        },
        [props, ghostPositions, opsEnabled, fireOps],
    );

    const onEdgesChange = useCallback(
        (changes: EdgeChange[]) => {
            for (const change of changes) {
                if (change.type === 'remove') {
                    props.removeEdge(change.id);
                    setSelectedEdgeId((prev) => (prev === change.id ? null : prev));
                    if (opsEnabled) {
                        fireOps([{ op: 'delete_edge', id: change.id }], {
                            nodes: [],
                            edges: [],
                        });
                    }
                } else if (change.type === 'select') {
                    if (change.selected) setSelectedEdgeId(change.id);
                    else {
                        setSelectedEdgeId((prev) => (prev === change.id ? null : prev));
                    }
                }
            }
        },
        [props, opsEnabled, fireOps],
    );

    const onConnect = useCallback(
        (connection: Connection) => {
            if (!connection.source || !connection.target) return;
            const id = `${connection.source}->${connection.target}`;
            if (props.edges.some((e) => e.id === id)) return;
            let sourcePort = connection.sourceHandle ?? undefined;
            let targetPort = connection.targetHandle ?? undefined;
            const kind = props.graphKind;

            const sourceNode = props.nodes.find((n) => n.id === connection.source);
            if (sourceNode?.type === 'debug_probe') {
                const check = probeAttachCheck(props.nodes, connection.source, connection.target);
                if (!check.ok) return;
                if (props.updateNodeConfig) {
                    props.updateNodeConfig(connection.source, {
                        attachedTo: connection.target,
                    } as Partial<Node>);
                }
                return;
            }

            if (kind === 'toolpack') {
                const check = canConnectToolPack(props.nodes, connection.source, connection.target);
                if (!check.ok) return;
            } else if (kind === 'skillpack') {
                const check = canConnectSkillPack(
                    props.nodes,
                    connection.source,
                    connection.target,
                );
                if (!check.ok) return;
            } else if (kind === 'handler') {
                const check = canConnectHandler(props.nodes, connection.source, connection.target);
                if (!check.ok) return;
            } else if (kind === 'cli_invocation') {
                const check = canConnectCliInvocation(
                    props.nodes,
                    connection.source,
                    connection.target,
                );
                if (!check.ok) return;
            } else if (kind === 'l1') {
                const check = canConnect(
                    props.nodes,
                    connection.source,
                    connection.target,
                    connection.sourceHandle,
                    connection.targetHandle,
                );
                if (!check.ok) return;
                const ports = resolvePortsL1(
                    props.nodes,
                    connection.source,
                    connection.target,
                    connection.sourceHandle,
                    connection.targetHandle,
                );
                sourcePort = sourcePort ?? ports.source_port;
                targetPort = targetPort ?? ports.target_port;
            } else {
                const check = canConnectL2(
                    props.nodes,
                    connection.source,
                    connection.target,
                    connection.sourceHandle,
                    connection.targetHandle,
                );
                if (!check.ok) return;
            }
            const edge: Edge = {
                id,
                source: {
                    node_id: connection.source,
                    ...(sourcePort ? { port_id: sourcePort } : {}),
                },
                target: {
                    node_id: connection.target,
                    ...(targetPort ? { port_id: targetPort } : {}),
                },
            };
            props.addEdge(edge);
            if (opsEnabled) {
                fireOps(
                    [
                        {
                            op: 'add_edge',
                            source: connection.source,
                            target: connection.target,
                            ...(sourcePort ? { source_port: sourcePort } : {}),
                            ...(targetPort ? { target_port: targetPort } : {}),
                        },
                    ],
                    { nodes: [], edges: [id] },
                );
            }
        },
        [props, opsEnabled, fireOps],
    );

    const isValidConnection = useCallback(
        (connection: Connection | FlowEdge) => {
            if (!connection.source || !connection.target) return false;
            const sh = 'sourceHandle' in connection ? connection.sourceHandle : null;
            const th = 'targetHandle' in connection ? connection.targetHandle : null;
            const kind = props.graphKind;
            const sourceNode = props.nodes.find((n) => n.id === connection.source);
            if (sourceNode?.type === 'debug_probe') {
                return probeAttachCheck(props.nodes, connection.source, connection.target).ok;
            }
            const check =
                kind === 'toolpack'
                    ? canConnectToolPack(props.nodes, connection.source, connection.target)
                    : kind === 'skillpack'
                      ? canConnectSkillPack(props.nodes, connection.source, connection.target)
                      : kind === 'handler'
                        ? canConnectHandler(props.nodes, connection.source, connection.target)
                        : kind === 'cli_invocation'
                          ? canConnectCliInvocation(
                                props.nodes,
                                connection.source,
                                connection.target,
                            )
                          : kind === 'l1'
                            ? canConnect(props.nodes, connection.source, connection.target, sh, th)
                            : canConnectL2(
                                  props.nodes,
                                  connection.source,
                                  connection.target,
                                  sh,
                                  th,
                              );
            return check.ok;
        },
        [props.graphKind, props.nodes],
    );

    const onPaneClick = useCallback(() => {
        props.setSelectedNodeId(null);
        setSelectedNodeIds((prev) => (prev.size ? new Set<string>() : prev));
        setSelectedEdgeId(null);
    }, [props]);

    const onToggleGhostsHidden = useCallback(() => {
        if (props.graphKind !== 'l1' || !props.graphId) return;
        const next = !ghostsHidden;
        setGhostsHiddenState(next);
        saveGhostsHidden(props.graphId, next);
        if (next && props.selectedNodeId && props.selectedNodeId.startsWith(GHOST_PREFIX)) {
            props.setSelectedNodeId(null);
            setSelectedNodeIds((prev) => {
                const without = new Set([...prev].filter((id) => !id.startsWith(GHOST_PREFIX)));
                return without.size === prev.size ? prev : without;
            });
        }
    }, [props, ghostsHidden]);

    const doSavePreset = useCallback(
        (rawIds: Iterable<string>) => {
            if (!props.onSaveSelectionPreset) return;
            const ids = [...rawIds].filter((id) => !id.startsWith(GHOST_PREFIX));
            if (ids.length < 2) return;
            const fragment = extractFragment(
                { kind: props.graphKind, nodes: [...props.nodes], edges: [...props.edges] },
                ids,
            );
            if (fragment.nodes.length < 2) return;
            const cx =
                fragment.nodes.reduce((sum, n) => sum + n.position.x, 0) / fragment.nodes.length;
            const cy =
                fragment.nodes.reduce((sum, n) => sum + n.position.y, 0) / fragment.nodes.length;
            const recentered = fragment.nodes.map((n) => ({
                ...n,
                position: { x: n.position.x - cx, y: n.position.y - cy },
            }));
            const name =
                typeof window !== 'undefined' ? window.prompt('Save preset — name?') : null;
            if (!name || !name.trim()) return;
            void props.onSaveSelectionPreset({
                kind: fragment.kind,
                nodes: recentered,
                edges: fragment.edges,
                name: name.trim(),
            });
            props.setSelectedNodeId(null);
            setSelectedNodeIds((prev) => (prev.size ? new Set<string>() : prev));
        },
        [props],
    );

    const realSelectedCount = useMemo(() => {
        const present = new Set(props.nodes.map((n) => n.id));
        return [...selectedNodeIds].filter((id) => !id.startsWith(GHOST_PREFIX) && present.has(id))
            .length;
    }, [selectedNodeIds, props.nodes]);

    const onNodeDoubleClick = useCallback(
        (_ev: React.MouseEvent, node: FlowNode) => {
            if (node.id.startsWith(GHOST_PREFIX)) return;
            props.onNodeDoubleClick?.(node.id, node.type ?? '');
        },
        [props],
    );

    const onDragOver = useCallback((ev: React.DragEvent) => {
        if (
            !ev.dataTransfer.types.includes(DRAG_MIME) &&
            !ev.dataTransfer.types.includes(LIBRARY_DRAG_MIME)
        ) {
            return;
        }
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
    }, []);

    const allowedKinds = useMemo(
        () => paletteKindsForGraphKind(props.graphKind),
        [props.graphKind],
    );

    const onDrop = useCallback(
        (ev: React.DragEvent) => {
            ev.preventDefault();
            const libraryId = ev.dataTransfer.getData(LIBRARY_DRAG_MIME);
            if (libraryId) {
                if (!props.onLibraryDrop) return;
                const position = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
                void props.onLibraryDrop(libraryId, position);
                return;
            }
            const kind = ev.dataTransfer.getData(DRAG_MIME) as PaletteKind;
            if (!allowedKinds.has(kind)) return;
            if (
                (kind === 'gateway' || kind === 'output') &&
                props.nodes.some((n) => n.type === kind)
            ) {
                return;
            }
            const position = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
            if (kind === 'pi_agent' && props.onPiAgentDrop) {
                void props.onPiAgentDrop(position);
                return;
            }
            const node = buildNode(kind, position);
            props.addNode(node);
            props.setSelectedNodeId(node.id);
            if (opsEnabled) {
                const {
                    id: _id,
                    type: _type,
                    position: _pos,
                    ...config
                } = node as unknown as Record<string, unknown>;
                void _id;
                void _type;
                void _pos;
                const placeholder = `$opt-${node.id}`;
                fireOps(
                    [
                        {
                            op: 'add_node',
                            kind: node.type,
                            position,
                            ...(Object.keys(config).length > 0 ? { config } : {}),
                            as: placeholder,
                        },
                    ],
                    { nodes: [node.id], edges: [] },
                );
            }
        },
        [allowedKinds, props, rf, opsEnabled, fireOps],
    );

    const propsRef = useRef(props);
    propsRef.current = props;
    const doSavePresetRef = useRef(doSavePreset);
    doSavePresetRef.current = doSavePreset;
    useEffect(() => {
        function isEditableTarget(): boolean {
            const el = document.activeElement as HTMLElement | null;
            if (!el) return false;
            const tag = el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
            if (el.isContentEditable) return true;
            return false;
        }

        function selectedNodeIds(): string[] {
            const live = rf
                .getNodes()
                .filter((n) => n.selected)
                .map((n) => n.id);
            if (live.length > 0) return live;
            const single = propsRef.current.selectedNodeId;
            return single ? [single] : [];
        }

        async function writeClipboard(text: string): Promise<void> {
            memoryClipboardRef.current = text;
            try {
                if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    await navigator.clipboard.writeText(text);
                }
            } catch {
                // best-effort; the in-memory ref already covers same-tab paste.
            }
        }

        async function readClipboard(): Promise<string> {
            try {
                if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    const text = await navigator.clipboard.readText();
                    if (text) return text;
                }
            } catch {
                // permission denied / insecure context — fall through to memory ref.
            }
            return memoryClipboardRef.current ?? '';
        }

        function doCopy(ids: string[]): boolean {
            if (ids.length === 0) return false;
            const p = propsRef.current;
            const fragment = extractFragment(
                { kind: p.graphKind, nodes: [...p.nodes], edges: [...p.edges] },
                ids,
            );
            if (fragment.nodes.length === 0) return false;
            void writeClipboard(serializeFragment(fragment));
            return true;
        }

        async function doPaste(): Promise<void> {
            const p = propsRef.current;
            if (!p.cloneSubtree || (!p.onOpsApplied && !p.replaceGraph)) return;
            const text = await readClipboard();
            if (!text) return;
            let result;
            try {
                result = await buildPastedGraph(
                    { kind: p.graphKind, nodes: [...p.nodes], edges: [...p.edges] },
                    text,
                    { x: 24, y: 24 },
                    p.cloneSubtree,
                );
            } catch (err) {
                if (err instanceof Error && err.message.startsWith('kind mismatch') && p.setError) {
                    const match = /fragment is (\w+), target is (\w+)/.exec(err.message);
                    const fragKind = match?.[1] ?? '<unknown>';
                    const graphKind = match?.[2] ?? p.graphKind;
                    p.setError(
                        `Cannot paste — clipboard is a ${fragKind} fragment, current graph is ${graphKind}.`,
                    );
                } else if (err instanceof Error && p.setError) {
                    p.setError(`Paste failed: ${err.message}`);
                }
                return;
            }
            if (!result) return;
            if (p.onOpsApplied) {
                p.onOpsApplied(result.graph, result.remap);
            } else {
                p.replaceGraph?.(result.graph);
            }
            if (result.addedNodeIds.length > 0) {
                p.setSelectedNodeId(result.addedNodeIds[0] ?? null);
            }
        }

        function onKeyDown(ev: KeyboardEvent) {
            if (!(ev.metaKey || ev.ctrlKey)) return;
            const key = ev.key.toLowerCase();
            if (key === 's' && ev.shiftKey) {
                if (isEditableTarget()) return;
                const ids = selectedNodeIds();
                if (ids.length < 2) return;
                ev.preventDefault();
                doSavePresetRef.current(ids);
                return;
            }
            if (key !== 'c' && key !== 'x' && key !== 'v') return;
            if (isEditableTarget()) return;
            if (key === 'c') {
                const ids = selectedNodeIds();
                if (doCopy(ids)) ev.preventDefault();
                return;
            }
            if (key === 'x') {
                const ids = selectedNodeIds();
                if (!doCopy(ids)) return;
                ev.preventDefault();
                const p = propsRef.current;
                for (const id of ids) p.removeNode(id);
                return;
            }
            if (key === 'v') {
                void doPaste();
                return;
            }
        }

        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [rf]);

    return (
        <div
            ref={wrapperRef}
            data-graph-kind={props.graphKind}
            className="h-full w-full"
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            <ReactFlow
                className={selectedNodeIds.size >= 2 ? 'fab-has-multi-selection' : undefined}
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                isValidConnection={isValidConnection}
                onPaneClick={onPaneClick}
                onNodeDoubleClick={onNodeDoubleClick}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                deleteKeyCode={['Backspace', 'Delete']}
                connectionRadius={40}
                proOptions={{ hideAttribution: true }}
            >
                <Background variant={BackgroundVariant.Lines} gap={32} color="var(--rf-grid)" />
                <Controls showInteractive={false} />
                {props.onSaveSelectionPreset && realSelectedCount >= 2 && (
                    <Panel position="top-center">
                        <button
                            type="button"
                            onClick={() => doSavePreset(selectedNodeIds)}
                            title="Save the selected nodes as a reusable Library preset"
                            className="rounded-md border border-zinc-300 bg-white/90 px-2 py-1 text-[11px] font-medium text-zinc-700 shadow-sm backdrop-blur hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                            Save {realSelectedCount} nodes as preset
                        </button>
                    </Panel>
                )}
                {props.graphKind === 'l1' &&
                    props.parentContext &&
                    props.parentContext.nodes.length > 0 && (
                        <Panel position="top-right">
                            <button
                                type="button"
                                onClick={onToggleGhostsHidden}
                                title={
                                    ghostsHidden
                                        ? 'Show parent-context overlay'
                                        : 'Hide parent-context overlay'
                                }
                                className="rounded-md border border-zinc-300 bg-white/90 px-2 py-1 text-[11px] font-medium text-zinc-700 shadow-sm backdrop-blur hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                                {ghostsHidden ? 'Show ghosts' : 'Hide ghosts'}
                            </button>
                        </Panel>
                    )}
            </ReactFlow>
        </div>
    );
}

export function Canvas(props: Props) {
    return (
        <ReactFlowProvider>
            <CanvasInner {...props} />
        </ReactFlowProvider>
    );
}

export function isLoadedGraph(g: Graph | null): g is Graph & { id: string } {
    return Boolean(g?.id);
}

function ghostIndex(node: Node, nodes: ReadonlyArray<Node>): number {
    return nodes.findIndex((n) => n.id === node.id);
}
