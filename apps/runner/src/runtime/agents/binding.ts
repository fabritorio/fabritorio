import type { Edge, Graph, NodeType } from '@fabritorio/types';
import type { NodeBinding, NodeContext } from '../graph-runtime.js';
import { childDispatch } from '../dispatch.js';
import { emitForwardTraversal } from '../bindings/traversal.js';
import { isAgentType } from '../../graphs/invariant.js';
import type { Agent, AgentReply } from './agent.js';

export function targetsAgent(graph: Graph, edge: Edge): boolean {
    const target = graph.nodes.find((n) => n.id === edge.target.node_id);
    return target ? isAgentType(target.type) : false;
}

export function resolveReachableAgents(
    graph: Graph,
    outgoing: readonly Edge[],
): Array<{ id: string; displayName: string; description?: string }> {
    const out: Array<{ id: string; displayName: string; description?: string }> = [];
    for (const edge of outgoing) {
        if (!targetsAgent(graph, edge)) continue;
        const target = graph.nodes.find((n) => n.id === edge.target.node_id);
        if (!target) continue;
        const display = 'display_name' in target ? target.display_name : undefined;
        const description = 'description' in target ? target.description : undefined;
        out.push({
            id: target.id,
            displayName: display ?? target.id,
            ...(description ? { description } : {}),
        });
    }
    return out;
}

export interface AgentBindingSpec {
    nodeType: NodeType;
    build(ctx: NodeContext): Promise<Agent>;
    dependencies?(ctx: NodeContext): Promise<string[]>;
    isReferenceEdge(graph: Graph, edge: Edge): boolean;
}

export function createAgentBinding(spec: AgentBindingSpec): NodeBinding {
    const agents = new Map<string, Agent>();
    const buildErrors = new Map<string, string>();
    const keyOf = (graphId: string, nodeId: string) => `${graphId}:${nodeId}`;

    const binding: NodeBinding = {
        async activate(ctx) {
            if (ctx.node.type !== spec.nodeType) return null;
            if (!ctx.graph.id) {
                throw new Error(`${spec.nodeType} requires graph.id`);
            }
            const key = keyOf(ctx.graph.id, ctx.node.id);
            try {
                const agent = await spec.build(ctx);
                agents.set(key, agent);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                buildErrors.set(key, msg);
                console.warn(`[${spec.nodeType} ${ctx.node.id}] build failed: ${msg}`);
            }
            return {
                deactivate() {
                    agents.delete(key);
                    buildErrors.delete(key);
                },
            };
        },
        receiver(ctx, edge) {
            if (ctx.node.type !== spec.nodeType) return null;
            if (!ctx.graph.id) return null;
            if (spec.isReferenceEdge(ctx.graph, edge)) return null;
            const graphId = ctx.graph.id;
            const nodeId = ctx.node.id;
            return async (inbound) => {
                const key = keyOf(graphId, nodeId);
                const agent = agents.get(key);
                const buildError = buildErrors.get(key);
                if (!agent && !buildError) {
                    ctx.bus.emitObservability({
                        ts: new Date().toISOString(),
                        eventId: inbound.eventId,
                        parentId: inbound.eventId,
                        node_id: nodeId,
                        type: 'chain.stopped',
                        reason: 'agent not activated',
                    });
                    return;
                }

                ctx.bus.emitObservability({
                    ts: new Date().toISOString(),
                    eventId: inbound.eventId,
                    parentId: inbound.eventId,
                    node_id: nodeId,
                    type: 'gateway.received',
                    source: inbound.source,
                    messages: inbound.messages,
                });

                let emittedTerminal = false;
                try {
                    let reply: AgentReply;
                    let outputNodeId: string;
                    if (agent) {
                        try {
                            reply = await agent.dispatch(inbound, {
                                emitObservability: (e) => ctx.bus.emitObservability(e),
                            });
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            reply = {
                                output: { role: 'assistant', content: `[error] ${msg}` },
                                errored: true,
                            };
                        }
                        outputNodeId = agent.outputNodeId;
                    } else {
                        reply = {
                            output: { role: 'assistant', content: `[error] ${buildError}` },
                            errored: true,
                        };
                        outputNodeId = nodeId;
                    }

                    const port = reply.errored ? 'error' : 'result';
                    ctx.bus.emitObservability({
                        ts: new Date().toISOString(),
                        eventId: inbound.eventId,
                        parentId: inbound.eventId,
                        node_id: outputNodeId,
                        port_id: port,
                        type: 'output.emitted',
                        port,
                        messages: [reply.output],
                    });
                    emittedTerminal = true;
                    const child = childDispatch(inbound, {
                        messages: [reply.output],
                        meta: { port, ...(reply.stopped ? { stopped: true } : {}) },
                    });
                    ctx.bus.emitDispatch(child);
                    const replyEdges = ctx.outgoing.filter((e) => !targetsAgent(ctx.graph, e));
                    await Promise.all(
                        replyEdges.map((e) => {
                            emitForwardTraversal(ctx, e, inbound.eventId, port);
                            return ctx.bus.publish(ctx.topicFor(e), child);
                        }),
                    );
                } finally {
                    if (!emittedTerminal) {
                        ctx.bus.emitObservability({
                            ts: new Date().toISOString(),
                            eventId: inbound.eventId,
                            parentId: inbound.eventId,
                            node_id: nodeId,
                            type: 'chain.stopped',
                            reason: 'dispatch terminated without output',
                        });
                    }
                }
            };
        },
    };

    if (spec.dependencies) {
        binding.dependencies = spec.dependencies;
    }
    return binding;
}
