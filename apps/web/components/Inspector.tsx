'use client';

import { useMemo } from 'react';
import type { Edge, GraphKind, MemoryNode, Node } from '@fabritorio/types';
import type { RunnerClient } from '@/lib/runner-client';
import { isGhostId, stripGhostPrefix } from '@/lib/ghost';
import { isPresetSavable } from '@/lib/node-factory';
import { GatewayInspector } from './inspectors/l1/GatewayInspector';
import { OutputInspector } from './inspectors/l1/OutputInspector';
import { HandlerInspector } from './inspectors/l1/HandlerInspector';
import { ModelInspector } from './inspectors/l1/ModelInspector';
import { ModelRouterInspector } from './inspectors/l1/ModelRouterInspector';
import { SkillInspector } from './inspectors/l1/SkillInspector';
import { ToolInspector } from './inspectors/l1/ToolInspector';
import { SkillPackInspector } from './inspectors/l1/SkillPackInspector';
import { ToolPackInspector } from './inspectors/l1/ToolPackInspector';
import { CheckpointInspector } from './inspectors/l1/CheckpointInspector';
import { WorkspaceInspector } from './inspectors/l1/WorkspaceInspector';
import { SecretsInspector } from './inspectors/l1/SecretsInspector';
import { ChannelInspector } from './inspectors/l2/ChannelInspector';
import { TriggerInspector } from './inspectors/l2/TriggerInspector';
import { NativeAgentInspector } from './inspectors/l2/NativeAgentInspector';
import { CliAgentInspector } from './inspectors/l2/CliAgentInspector';
import { PiAgentInspector } from './inspectors/l2/PiAgentInspector';
import { MemoryInspector } from './inspectors/l2/MemoryInspector';
import { HandlerInputInspector } from './inspectors/l0/HandlerInputInspector';
import { HandlerOutputInspector } from './inspectors/l0/HandlerOutputInspector';
import { PromptBuilderInspector } from './inspectors/l0/PromptBuilderInspector';
import { ModelCallInspector } from './inspectors/l0/ModelCallInspector';
import { ToolExecInspector } from './inspectors/l0/ToolExecInspector';
import { EvaluatorInspector } from './inspectors/l0/EvaluatorInspector';
import { CliInvocationTargetInspector } from './inspectors/l0/CliInvocationTargetInspector';
import { DebugGatewayInspector } from './inspectors/debug/DebugGatewayInspector';
import { DebugProbeInspector } from './inspectors/debug/DebugProbeInspector';

interface Props {
    graphKind: GraphKind;
    selectedNodeId: string | null;
    nodes: ReadonlyArray<Node>;
    updateNodeConfig: (id: string, patch: Partial<Node>) => void;
    removeNode: (id: string) => void;
    edges?: ReadonlyArray<Edge>;
    updateEdge?: (id: string, patch: Partial<Edge>) => void;
    client?: RunnerClient;
    currentGraphId?: string | null;
    runningNodes?: ReadonlySet<string>;
    ghostNodes?: ReadonlyArray<Node>;
    onSelectNode?: (id: string) => void;
    onOpenTriggerRuns?: (nodeId: string) => void;
    onOpenAgentCalls?: (nodeId: string) => void;
    onSavePreset?: (nodeId: string) => void;
    onOpenChat?: (agentId: string, convId: string | null) => void;
    onConversationDeleted?: (convId: string) => void;
}

export function Inspector({
    selectedNodeId,
    nodes,
    edges,
    updateNodeConfig,
    updateEdge,
    removeNode,
    client,
    currentGraphId,
    runningNodes,
    ghostNodes,
    onSelectNode,
    onOpenTriggerRuns,
    onOpenAgentCalls,
    onSavePreset,
    onOpenChat,
    onConversationDeleted,
}: Props) {
    const isGhost = isGhostId(selectedNodeId);
    const node = useMemo(() => {
        if (!selectedNodeId) return null;
        if (isGhost) {
            const realId = stripGhostPrefix(selectedNodeId);
            return ghostNodes?.find((n) => n.id === realId) ?? null;
        }
        return nodes.find((n) => n.id === selectedNodeId) ?? null;
    }, [nodes, ghostNodes, selectedNodeId, isGhost]);
    const isRunning = !isGhost && node !== null && (runningNodes?.has(node.id) ?? false);
    const isReadOnly = isGhost || isRunning;

    return (
        <aside className="flex h-full w-full flex-col gap-3 overflow-y-auto border-l border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                    Inspector
                </span>
                {node && !isGhost && (
                    <div className="flex items-center gap-2">
                        {onSavePreset && isPresetSavable(node) && (
                            <button
                                type="button"
                                disabled={isRunning}
                                onClick={() => onSavePreset(node.id)}
                                title="Save this node's config as a draggable Library preset"
                                className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                                Save preset
                            </button>
                        )}
                        <button
                            type="button"
                            disabled={isRunning}
                            onClick={() => removeNode(node.id)}
                            className="rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70"
                        >
                            Delete
                        </button>
                    </div>
                )}
            </div>
            {!node ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-500">
                    Select a node to edit its config.
                </p>
            ) : (
                <>
                    {isGhost && <GhostBanner />}
                    {isRunning && <RunningBanner />}
                    {/* Memory ghost gets a special path: render MemoryInspector OUTSIDE
              the disabled fieldset so its Refresh button stays clickable.
              `<fieldset disabled>` cascades to every nested form control,
              and the Refresh button is a read action that should still work
              while the user is inspecting (not editing) the parent agent's
              live memory. The MemoryInspector itself respects `readOnly` to
              disable its config selects + textarea. All other ghost types
              fall through to the standard fieldset path. */}
                    {isGhost && node.type === 'memory' && client ? (
                        <MemoryInspector
                            node={node as MemoryNode}
                            onChange={updateNodeConfig}
                            client={client}
                            readOnly
                        />
                    ) : (
                        <fieldset
                            disabled={isReadOnly}
                            className="contents disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <NodeEditor
                                node={node}
                                allNodes={nodes}
                                allEdges={edges}
                                ghostNodes={ghostNodes}
                                onChange={updateNodeConfig}
                                onEdgeChange={updateEdge}
                                onSelectNode={onSelectNode}
                                client={client}
                                currentGraphId={currentGraphId ?? null}
                                onOpenTriggerRuns={onOpenTriggerRuns}
                                onOpenAgentCalls={onOpenAgentCalls}
                                onOpenChat={onOpenChat}
                                onConversationDeleted={onConversationDeleted}
                            />
                        </fieldset>
                    )}
                </>
            )}
        </aside>
    );
}

function RunningBanner() {
    return (
        <div className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-[11px] text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200">
            <span className="font-medium">View only.</span> This node is mid-Dispatch. Edits will
            re-enable when it frees.
        </div>
    );
}

function GhostBanner() {
    return (
        <div className="rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-700 dark:border-zinc-600/60 dark:bg-zinc-800/60 dark:text-zinc-300">
            <span className="font-medium">Parent context — read-only.</span> This node lives on the
            parent NativeAgent's L2; open that graph to edit it.
        </div>
    );
}

function NodeEditor({
    node,
    allNodes,
    allEdges,
    ghostNodes,
    onChange,
    onEdgeChange,
    onSelectNode,
    client,
    currentGraphId,
    onOpenTriggerRuns,
    onOpenAgentCalls,
    onOpenChat,
    onConversationDeleted,
}: {
    node: Node;
    allNodes: ReadonlyArray<Node>;
    allEdges?: ReadonlyArray<Edge>;
    ghostNodes?: ReadonlyArray<Node>;
    onChange: (id: string, patch: Partial<Node>) => void;
    onEdgeChange?: (id: string, patch: Partial<Edge>) => void;
    onSelectNode?: (id: string) => void;
    client?: RunnerClient;
    currentGraphId: string | null;
    onOpenTriggerRuns?: (nodeId: string) => void;
    onOpenAgentCalls?: (nodeId: string) => void;
    onOpenChat?: (agentId: string, convId: string | null) => void;
    onConversationDeleted?: (convId: string) => void;
}) {
    switch (node.type) {
        case 'gateway':
            return <GatewayInspector node={node} />;
        case 'output':
            return <OutputInspector node={node} />;
        case 'handler':
            return <HandlerInspector node={node} onChange={onChange} />;
        case 'model':
            return <ModelInspector node={node} onChange={onChange} />;
        case 'model_router':
            return (
                <ModelRouterInspector
                    node={node}
                    allNodes={allNodes}
                    allEdges={allEdges ?? []}
                    onChange={onChange}
                    onEdgeChange={onEdgeChange}
                />
            );
        case 'skill':
            return <SkillInspector node={node} onChange={onChange} client={client} />;
        case 'skill_pack':
            return (
                <SkillPackInspector
                    node={node}
                    onChange={onChange}
                    currentGraphId={currentGraphId}
                />
            );
        case 'tool':
            return <ToolInspector node={node} onChange={onChange} client={client} />;
        case 'tool_pack':
            return (
                <ToolPackInspector
                    node={node}
                    onChange={onChange}
                    currentGraphId={currentGraphId}
                />
            );
        case 'workspace':
            return <WorkspaceInspector node={node} onChange={onChange} />;
        case 'secrets':
            return <SecretsInspector node={node} onChange={onChange} />;
        case 'checkpoint':
            return (
                <CheckpointInspector
                    node={node}
                    ghostNodes={ghostNodes ?? []}
                    onChange={onChange}
                    onSelectNode={onSelectNode}
                />
            );
        case 'channel':
            return <ChannelInspector node={node} onChange={onChange} />;
        case 'trigger':
            return (
                <TriggerInspector
                    node={node}
                    onChange={onChange}
                    onOpenRuns={onOpenTriggerRuns}
                    client={client}
                    currentGraphId={currentGraphId}
                />
            );
        case 'native_agent':
            return (
                <NativeAgentInspector
                    node={node}
                    onChange={onChange}
                    onOpenCalls={onOpenAgentCalls}
                    allNodes={allNodes}
                    client={client}
                    currentGraphId={currentGraphId}
                    onOpenChat={onOpenChat}
                    onConversationDeleted={onConversationDeleted}
                />
            );
        case 'cli_agent':
            return (
                <CliAgentInspector
                    node={node}
                    onChange={onChange}
                    client={client}
                    currentGraphId={currentGraphId}
                    allNodes={allNodes}
                    onOpenChat={onOpenChat}
                    onConversationDeleted={onConversationDeleted}
                />
            );
        case 'pi_agent':
            return (
                <PiAgentInspector
                    node={node}
                    onChange={onChange}
                    client={client}
                    currentGraphId={currentGraphId}
                    allNodes={allNodes}
                    onOpenChat={onOpenChat}
                    onConversationDeleted={onConversationDeleted}
                />
            );
        case 'memory':
            return <MemoryInspector node={node} onChange={onChange} client={client} />;
        case 'handler_input':
            return <HandlerInputInspector node={node} />;
        case 'handler_output':
            return <HandlerOutputInspector node={node} />;
        case 'prompt_builder':
            return <PromptBuilderInspector node={node} />;
        case 'model_call':
            return <ModelCallInspector node={node} />;
        case 'tool_exec':
            return <ToolExecInspector node={node} />;
        case 'evaluator':
            return <EvaluatorInspector node={node} />;
        case 'cli_invocation_target':
            return <CliInvocationTargetInspector node={node} onChange={onChange} />;
        case 'debug_gateway':
            return <DebugGatewayInspector node={node} onChange={onChange} />;
        case 'debug_probe':
            return (
                <DebugProbeInspector
                    node={node}
                    allNodes={allNodes}
                    onChange={onChange}
                    client={client}
                    currentGraphId={currentGraphId}
                />
            );
    }
}
