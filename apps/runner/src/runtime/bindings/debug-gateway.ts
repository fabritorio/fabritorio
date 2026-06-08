import type { DebugGatewayNode, DispatchEvent, Edge, Message, ModelNode } from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';
import type { GraphRuntimeRegistry, NodeBinding } from '../graph-runtime.js';
import type { BuiltinToolBuildCtx, BuiltinToolDispatchContext } from '../builtin-tools.js';
import { childDispatch, newDispatch } from '../dispatch.js';
import { emitForwardTraversal } from './traversal.js';
import { buildHandlerFromL1, collectL1Dependencies } from '../agents/handler-from-l1.js';
import { resolveReachableAgents } from '../agents/binding.js';
import { findParentNativeAgentForL1, findWiredMemoryNodes } from '../agents/wiring.js';
import type { Handler } from '../handlers/handler.js';
import type { HandlerRegistry } from '../handlers/registry.js';
import type { MemoryHandle, MemoryRegistry } from '../memory.js';
import { partitionMemoryNodes } from '../memory.js';
import type { ModelClient } from '../model.js';
import type { DispatchAbortRegistry } from '../dispatch-aborts.js';
import type { PermissionGateRegistry } from '../permission.js';
import type { RuntimeToolRegistry } from '../runtime-tools.js';
import type { SecretsStore } from '../secrets-store.js';
import type { SkillRegistry } from '../skills.js';
import {
    createDebugGatewayRegistry,
    type DebugGatewayHandle,
    type DebugGatewayRegistry,
} from '../debug.js';

export interface DebugGatewayBindingDeps {
    graphStore: GraphStore;
    skillRegistry: SkillRegistry;
    modelClientFor: (node: ModelNode) => ModelClient;
    handlerRegistry: HandlerRegistry;
    memoryRegistry?: MemoryRegistry;
    registry?: DebugGatewayRegistry;
    permissionGateRegistry?: PermissionGateRegistry;
    runtimesRef?: () => GraphRuntimeRegistry | undefined;
    runtimeToolRegistry?: RuntimeToolRegistry;
    secretsStore?: SecretsStore;
    dispatchAborts?: DispatchAbortRegistry;
}

export interface DebugGatewayBindingResult {
    binding: NodeBinding;
    registry: DebugGatewayRegistry;
}

export function createDebugGatewayBinding(
    deps: DebugGatewayBindingDeps,
): DebugGatewayBindingResult {
    const registry = deps.registry ?? createDebugGatewayRegistry();

    const binding: NodeBinding = {
        async dependencies(ctx) {
            if (ctx.node.type !== 'debug_gateway') return [];
            if (ctx.graph.kind !== 'l1') return [];
            return collectL1Dependencies(ctx.graph);
        },

        async activate(ctx) {
            if (ctx.node.type !== 'debug_gateway') return null;
            if (!ctx.graph.id) {
                throw new Error('debug_gateway requires a graph.id');
            }
            const node = ctx.node as DebugGatewayNode;
            const graphId = ctx.graph.id;
            const layer = ctx.graph.kind === 'l1' ? 'l1' : 'l2';

            const subs = new Set<(event: DispatchEvent) => void>();
            const closers = new Set<() => void>();
            const rootsBySource = new Map<string, string[]>();
            function recordRoot(source: string, eventId: string): void {
                let list = rootsBySource.get(source);
                if (!list) {
                    list = [];
                    rootsBySource.set(source, list);
                }
                list.push(eventId);
            }

            let handler: Handler | null = null;
            let outputNodeId: string | null = null;
            let memoryHandleFor: () => MemoryHandle | undefined = () => undefined;
            const dispatchHolder: { current: DispatchEvent | null } = { current: null };
            if (layer === 'l1') {
                let injectedMemoriesForBuilder: import('@fabritorio/types').MemoryNode[] = [];
                let toolMemoryHandle: MemoryHandle | undefined;
                let historyMemoryNodeId: string | null = null;
                let builtinToolBuildCtx: BuiltinToolBuildCtx | undefined;
                const parent = await findParentNativeAgentForL1(deps.graphStore, graphId);
                if (parent) {
                    const wiredMemories = findWiredMemoryNodes(parent.graph, parent.agentNode.id);
                    const { historyMemory, injectedMemories, toolMemory } =
                        partitionMemoryNodes(wiredMemories);
                    injectedMemoriesForBuilder = injectedMemories;
                    if (historyMemory && deps.memoryRegistry) {
                        deps.memoryRegistry.resolve(historyMemory);
                        historyMemoryNodeId = historyMemory.id;
                    }
                    if (toolMemory && deps.memoryRegistry) {
                        toolMemoryHandle = deps.memoryRegistry.resolve(toolMemory);
                    }

                    const agentNodeId = parent.agentNode.id;
                    const outgoing: readonly Edge[] = parent.graph.edges.filter(
                        (e) => e.source.node_id === agentNodeId,
                    );
                    const topicFor = (edge: Edge): string => edge.id;
                    const reachableAgents = resolveReachableAgents(parent.graph, outgoing);
                    builtinToolBuildCtx = {
                        bus: ctx.bus,
                        callerNodeId: agentNodeId,
                        currentContext(): BuiltinToolDispatchContext | null {
                            if (!dispatchHolder.current) return null;
                            return {
                                currentDispatch: dispatchHolder.current,
                                outgoing,
                                topicFor,
                            };
                        },
                        reachableAgents,
                    };
                }

                const runtimes = deps.runtimesRef?.();
                const memoryRegistry = deps.memoryRegistry;
                const built = await buildHandlerFromL1(
                    ctx.graph,
                    {
                        ...deps,
                        ...(runtimes ? { runtimes } : {}),
                        ...(builtinToolBuildCtx ? { builtinToolBuildCtx } : {}),
                    },
                    {
                        ownerLabel: `debug_gateway ${node.id}`,
                        injectedMemories: injectedMemoriesForBuilder,
                        ...(memoryRegistry
                            ? { resolveInjectedHandle: (n) => memoryRegistry.resolve(n) }
                            : {}),
                        ...(toolMemoryHandle ? { toolMemoryHandle } : {}),
                    },
                );
                handler = built.handler;
                outputNodeId = built.outputNodeId;

                if (historyMemoryNodeId && deps.memoryRegistry) {
                    const registry = deps.memoryRegistry;
                    const id = historyMemoryNodeId;
                    memoryHandleFor = () => registry.get(id);
                }
            }

            const handle: DebugGatewayHandle = {
                graphId,
                nodeId: node.id,
                layer,
                async publish({ content, source }) {
                    const src = source ?? `debug:${node.id}`;
                    const event = newDispatch({
                        source: src,
                        messages: [{ role: 'user', content }],
                    });
                    ctx.bus.emitDispatch(event);
                    recordRoot(src, event.eventId);

                    if (layer === 'l1') {
                        ctx.bus.emitObservability({
                            ts: new Date().toISOString(),
                            eventId: event.eventId,
                            parentId: event.eventId,
                            node_id: node.id,
                            type: 'gateway.received',
                            source: src,
                            messages: event.messages,
                        });
                        const memoryHandle = memoryHandleFor();
                        const priorHistory = memoryHandle
                            ? readMessageHistory(memoryHandle, src)
                            : [];
                        const merged: Message[] = [...priorHistory, ...event.messages];
                        let result;
                        const controller = deps.dispatchAborts?.mint(event.eventId, event.parentId);
                        dispatchHolder.current = event;
                        try {
                            result = await handler!.run(merged, {
                                eventId: event.eventId,
                                emitObservability: (e) => ctx.bus.emitObservability(e),
                                ...(controller ? { signal: controller.signal } : {}),
                            });
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            result = {
                                output: {
                                    role: 'assistant' as const,
                                    content: `[error] ${msg}`,
                                },
                                errored: true,
                            };
                        } finally {
                            dispatchHolder.current = null;
                            deps.dispatchAborts?.release(event.eventId);
                        }
                        if (memoryHandle && !result.errored) {
                            memoryHandle.write(src, [...merged, result.output]);
                        }
                        const port = result.errored ? 'error' : 'result';
                        ctx.bus.emitObservability({
                            ts: new Date().toISOString(),
                            eventId: event.eventId,
                            parentId: event.eventId,
                            node_id: outputNodeId!,
                            port_id: port,
                            type: 'output.emitted',
                            port,
                            messages: [result.output],
                        });
                        const child = childDispatch(event, {
                            messages: [result.output],
                            meta: { port },
                        });
                        ctx.bus.emitDispatch(child);
                        for (const sub of subs) sub(child);
                        return event;
                    }

                    await Promise.all(
                        ctx.outgoing.map((edge) => {
                            emitForwardTraversal(ctx, edge, event.eventId);
                            return ctx.bus.publish(ctx.topicFor(edge), event);
                        }),
                    );
                    return event;
                },
                subscribe(listener) {
                    subs.add(listener);
                    return () => {
                        subs.delete(listener);
                    };
                },
                onTeardown(closer) {
                    closers.add(closer);
                    return () => {
                        closers.delete(closer);
                    };
                },
                deliver(event) {
                    for (const sub of subs) sub(event);
                },
                rootsBySource(source) {
                    return [...(rootsBySource.get(source) ?? [])];
                },
                teardown() {
                    for (const closer of closers) {
                        try {
                            closer();
                        } catch {
                            /* best-effort socket close */
                        }
                    }
                    closers.clear();
                    subs.clear();
                },
            };

            registry.register(handle);
            return {
                deactivate() {
                    handle.teardown();
                    registry.unregister(graphId, node.id);
                },
            };
        },

        receiver(ctx, _edge) {
            if (ctx.node.type !== 'debug_gateway') return null;
            if (ctx.graph.kind !== 'l2') return null;
            const graphId = ctx.graph.id ?? '';
            const nodeId = ctx.node.id;
            return (event) => {
                const handle = registry.get(graphId, nodeId);
                if (handle) handle.deliver(event);
            };
        },
    };

    return { binding, registry };
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
