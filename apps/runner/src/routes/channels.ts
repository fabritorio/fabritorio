import type { FastifyInstance } from 'fastify';
import type { DispatchEvent } from '@fabritorio/types';
import type { ChannelRegistry } from '../runtime/channels.js';
import type { EventBus } from '../runtime/event-bus.js';
import type { GraphRuntimeRegistry } from '../runtime/graph-runtime.js';
import { writeSseHead } from '../runtime/sse.js';

export interface ChannelRoutesDeps {
    channels: ChannelRegistry;
    bus: EventBus;
    runtimes: GraphRuntimeRegistry;
}

interface ChannelParam {
    channelNodeId: string;
}

interface MessageBody {
    content?: unknown;
    source?: unknown;
    convId?: unknown;
}

const CHAT_SOURCE_PREFIX = 'chat:';

function chatSource(agentId: string, convId: string): string {
    return `${CHAT_SOURCE_PREFIX}${agentId}:${convId}`;
}

function shortToken(): string {
    return Math.random().toString(36).slice(2, 8);
}

function resolveOwnerAgentId(
    runtimes: GraphRuntimeRegistry,
    graphId: string,
    channelNodeId: string,
): string | null {
    const loaded = runtimes.get(graphId);
    if (!loaded) return null;
    const node = loaded.graph.nodes.find((n) => n.id === channelNodeId);
    if (!node || node.type !== 'channel') return null;
    return typeof node.owner_node_id === 'string' && node.owner_node_id ? node.owner_node_id : null;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRoutesDeps): void {
    app.post<{ Params: ChannelParam; Body: MessageBody }>(
        '/channels/webchat/:channelNodeId/message',
        async (req, reply) => {
            const channel = deps.channels.get(req.params.channelNodeId);
            if (!channel) {
                return reply.code(404).send({ error: 'channel not loaded' });
            }
            const body = (req.body ?? {}) as MessageBody;
            const content = typeof body.content === 'string' ? body.content : '';
            if (content.length === 0) {
                return reply.code(400).send({ error: 'content required' });
            }
            const explicitSource = typeof body.source === 'string' ? body.source : undefined;
            const explicitConvId = typeof body.convId === 'string' ? body.convId : undefined;

            const agentId = resolveOwnerAgentId(
                deps.runtimes,
                channel.graphId,
                req.params.channelNodeId,
            );

            let source = explicitSource;
            let convId: string | undefined;
            if (agentId) {
                if (explicitSource) {
                    source = explicitSource;
                    const expectedPrefix = `${CHAT_SOURCE_PREFIX}${agentId}:`;
                    if (explicitSource.startsWith(expectedPrefix)) {
                        convId = explicitSource.slice(expectedPrefix.length);
                    }
                } else if (explicitConvId) {
                    convId = explicitConvId;
                    source = chatSource(agentId, convId);
                } else {
                    convId = shortToken();
                    source = chatSource(agentId, convId);
                }
            }

            const event = await channel.publish({
                content,
                ...(source ? { source } : {}),
            });
            return reply.code(202).send({
                eventId: event.eventId,
                source: event.source,
                timestamp: event.timestamp,
                ...(convId ? { convId } : {}),
            });
        },
    );

    app.get<{ Params: ChannelParam }>('/channels/webchat/:channelNodeId/stream', (req, reply) => {
        const channel = deps.channels.get(req.params.channelNodeId);
        if (!channel) {
            reply.code(404).send({ error: 'channel not loaded' });
            return reply;
        }

        writeSseHead(req, reply);
        reply.raw.write(`: connected\n\n`);

        const off = channel.subscribe((event: DispatchEvent) => {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const offTeardown = channel.onTeardown(() => {
            try {
                reply.raw.end();
            } catch {
                /* socket already closed */
            }
        });

        const close = () => {
            off();
            offTeardown();
            try {
                reply.raw.end();
            } catch {
                /* socket already closed */
            }
        };
        req.raw.on('close', close);
        req.raw.on('error', close);
        return reply;
    });

    app.get<{
        Params: ChannelParam;
        Querystring: { source?: string };
    }>('/channels/webchat/:channelNodeId/replay', (req, reply) => {
        const channel = deps.channels.get(req.params.channelNodeId);
        if (!channel) {
            return reply.code(404).send({ error: 'channel not loaded' });
        }
        const source =
            typeof req.query.source === 'string' && req.query.source.length > 0
                ? req.query.source
                : `webchat:${req.params.channelNodeId}`;
        const roots = channel.rootsBySource(source);
        const events = roots.flatMap((eventId) => deps.bus.eventsByDispatch(eventId));
        return reply.send({ source, roots, events });
    });
}
