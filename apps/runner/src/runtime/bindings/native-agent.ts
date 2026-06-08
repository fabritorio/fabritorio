import type {
    DispatchEvent,
    Graph,
    MemoryNode,
    Message,
    ModelNode,
    NativeAgentNode,
    NodeType,
} from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';
import type { BuiltinToolBuildCtx, BuiltinToolDispatchContext } from '../builtin-tools.js';
import type { Handler } from '../handlers/handler.js';
import type { HandlerRegistry } from '../handlers/registry.js';
import type { MemoryHandle, MemoryRegistry } from '../memory.js';
import {
    LAST_N_DEFAULT,
    LAST_WITHIN_TOKENS_DEFAULT,
    partitionMemoryNodes,
    windowMessagesByTokenBudget,
    windowMessagesByTurns,
} from '../memory.js';
import type { ModelClient } from '../model.js';
import type { DispatchAbortRegistry } from '../dispatch-aborts.js';
import type { PermissionGateRegistry } from '../permission.js';
import type { RuntimeToolRegistry } from '../runtime-tools.js';
import type { SecretsStore } from '../secrets-store.js';
import type { SkillRegistry } from '../skills.js';
import type { GraphRuntimeRegistry, NodeBinding } from '../graph-runtime.js';
import type { Agent, AgentDispatchCtx, AgentReply } from '../agents/agent.js';
import { createAgentBinding, resolveReachableAgents } from '../agents/binding.js';
import { buildHandlerFromL1, collectL1Dependencies } from '../agents/handler-from-l1.js';
import { findWiredMemoryNodes, makeIsReferenceEdge } from '../agents/wiring.js';

export interface NativeAgentBindingDeps {
    graphStore: GraphStore;
    skillRegistry: SkillRegistry;
    modelClientFor: (node: ModelNode) => ModelClient;
    memoryRegistry: MemoryRegistry;
    handlerRegistry: HandlerRegistry;
    permissionGateRegistry?: PermissionGateRegistry;
    runtimesRef?: () => GraphRuntimeRegistry | undefined;
    runtimeToolRegistry?: RuntimeToolRegistry;
    secretsStore?: SecretsStore;
    dispatchAborts?: DispatchAbortRegistry;
}

type HistoryStrategy =
    | { kind: 'full_history' }
    | { kind: 'last_n'; n: number }
    | { kind: 'last_within_tokens'; tokenBudget: number };

class NativeAgent implements Agent {
    constructor(
        public readonly outputNodeId: string,
        private readonly handler: Handler,
        private readonly memoryHandleFor: () => MemoryHandle | undefined,
        private readonly historyStrategy: HistoryStrategy | null,
        private readonly dispatchHolder: { current: DispatchEvent | null },
        private readonly dispatchAborts: DispatchAbortRegistry | undefined,
    ) {}

    async dispatch(inbound: DispatchEvent, ctx: AgentDispatchCtx): Promise<AgentReply> {
        const memoryHandle = this.memoryHandleFor();
        const stored = memoryHandle ? readMessageHistory(memoryHandle, inbound.source) : [];
        const priorHistory = this.sliceHistory(stored);
        const merged: Message[] = [...priorHistory, ...inbound.messages];

        const controller = this.dispatchAborts?.mint(inbound.eventId, inbound.parentId);

        this.dispatchHolder.current = inbound;
        let result: AgentReply;
        try {
            result = await this.handler.run(merged, {
                eventId: inbound.eventId,
                emitObservability: ctx.emitObservability,
                ...(controller ? { signal: controller.signal } : {}),
            });
        } finally {
            this.dispatchHolder.current = null;
            this.dispatchAborts?.release(inbound.eventId);
        }

        if (memoryHandle && !result.errored && !result.stopped) {
            memoryHandle.write(inbound.source, [...stored, ...inbound.messages, result.output]);
        }
        return result;
    }

    private sliceHistory(stored: Message[]): Message[] {
        const strategy = this.historyStrategy;
        if (!strategy) return stored;
        switch (strategy.kind) {
            case 'last_n':
                return windowMessagesByTurns(stored, strategy.n);
            case 'last_within_tokens':
                return windowMessagesByTokenBudget(stored, strategy.tokenBudget);
            case 'full_history':
                return stored;
        }
    }
}

const NATIVE_REFERENCE_SOURCES: ReadonlySet<NodeType> = new Set<NodeType>(['memory']);
const isReferenceEdge = makeIsReferenceEdge(NATIVE_REFERENCE_SOURCES);

export function createNativeAgentBinding(deps: NativeAgentBindingDeps): NodeBinding {
    return createAgentBinding({
        nodeType: 'native_agent',
        isReferenceEdge,
        async dependencies(ctx) {
            if (ctx.node.type !== 'native_agent') return [];
            const node = ctx.node as NativeAgentNode;
            const ids: string[] = [node.l1_graph_id];
            const l1 = await deps.graphStore.get(node.l1_graph_id);
            if (!l1) return ids;
            ids.push(...(await collectL1Dependencies(l1)));
            return ids;
        },
        async build(ctx) {
            const node = ctx.node as NativeAgentNode;
            const l1 = await deps.graphStore.get(node.l1_graph_id);
            if (!l1) {
                throw new Error(`native_agent ${node.id}: L1 graph ${node.l1_graph_id} not found`);
            }
            if (l1.kind !== 'l1') {
                throw new Error(
                    `native_agent ${node.id}: graph ${node.l1_graph_id} is not L1 (kind=${l1.kind})`,
                );
            }
            const wiredMemories = findWiredMemoryNodes(ctx.graph, node.id);
            const dispatchHolder: { current: DispatchEvent | null } = { current: null };
            const outgoingSnapshot = [...ctx.outgoing];
            const topicFor = ctx.topicFor;
            const reachableAgents = resolveReachableAgents(ctx.graph, outgoingSnapshot);
            const builtinToolBuildCtx: BuiltinToolBuildCtx = {
                bus: ctx.bus,
                callerNodeId: node.id,
                currentContext(): BuiltinToolDispatchContext | null {
                    if (!dispatchHolder.current) return null;
                    return {
                        currentDispatch: dispatchHolder.current,
                        outgoing: outgoingSnapshot,
                        topicFor,
                    };
                },
                reachableAgents,
            };
            return buildNativeAgent(
                node,
                l1,
                deps,
                wiredMemories,
                dispatchHolder,
                builtinToolBuildCtx,
            );
        },
    });
}

async function buildNativeAgent(
    agentNode: NativeAgentNode,
    l1: Graph,
    deps: NativeAgentBindingDeps,
    wiredMemories: MemoryNode[],
    dispatchHolder: { current: DispatchEvent | null },
    builtinToolBuildCtx: BuiltinToolBuildCtx,
): Promise<NativeAgent> {
    const { historyMemory, injectedMemories, toolMemory } = partitionMemoryNodes(wiredMemories);

    const toolMemoryHandle = toolMemory ? deps.memoryRegistry.resolve(toolMemory) : undefined;

    const runtimes = deps.runtimesRef?.();
    const { handler: handlerInstance, outputNodeId } = await buildHandlerFromL1(
        l1,
        {
            ...deps,
            ...(runtimes ? { runtimes } : {}),
            builtinToolBuildCtx,
        },
        {
            injectedMemories,
            resolveInjectedHandle: (n) => deps.memoryRegistry.resolve(n),
            ...(toolMemoryHandle ? { toolMemoryHandle } : {}),
            ownerLabel: `native_agent ${agentNode.id}`,
        },
    );

    const memoryHandleFor = historyMemory
        ? (() => {
              const handle = deps.memoryRegistry.resolve(historyMemory);
              return () => handle;
          })()
        : () => undefined;

    const historyStrategy: HistoryStrategy | null = historyMemory
        ? buildHistoryStrategy(historyMemory)
        : null;

    return new NativeAgent(
        outputNodeId,
        handlerInstance,
        memoryHandleFor,
        historyStrategy,
        dispatchHolder,
        deps.dispatchAborts,
    );
}

function buildHistoryStrategy(node: MemoryNode): HistoryStrategy {
    if (node.handling === 'last_n') {
        const n = typeof node.n === 'number' && node.n > 0 ? Math.floor(node.n) : LAST_N_DEFAULT;
        return { kind: 'last_n', n };
    }
    if (node.handling === 'last_within_tokens') {
        const tokenBudget =
            typeof node.token_budget === 'number' && node.token_budget > 0
                ? Math.floor(node.token_budget)
                : LAST_WITHIN_TOKENS_DEFAULT;
        return { kind: 'last_within_tokens', tokenBudget };
    }
    return { kind: 'full_history' };
}

function readMessageHistory(handle: MemoryHandle, key: string): Message[] {
    const raw = handle.read(key);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (m): m is Message =>
            typeof m === 'object' &&
            m !== null &&
            typeof (m as { role?: unknown }).role === 'string' &&
            typeof (m as { content?: unknown }).content === 'string',
    );
}
