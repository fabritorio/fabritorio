import type { DispatchEvent } from '@fabritorio/types';
import { newDispatch } from '../dispatch.js';
import { emitForwardTraversal } from './traversal.js';
import type { NodeBinding } from '../graph-runtime.js';
import type { ChannelRegistry, WebchatChannel } from '../channels.js';

export function createWebchatBinding(registry: ChannelRegistry): NodeBinding {
    return {
        activate(ctx) {
            if (ctx.node.type !== 'channel') return null;
            if (!ctx.graph.id) {
                throw new Error('webchat channel requires a graph.id');
            }
            const subs = new Set<(event: DispatchEvent) => void>();
            const closers = new Set<() => void>();

            const channel: WebchatChannel = {
                graphId: ctx.graph.id,
                channelNodeId: ctx.node.id,
                async publish({ content, source }) {
                    const src = source ?? `webchat:${ctx.node.id}`;
                    const event = newDispatch({
                        source: src,
                        messages: [{ role: 'user', content }],
                    });
                    ctx.bus.emitDispatch(event);
                    channel.deliver(event);
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
                rootsBySource(src) {
                    return ctx.bus.rootEventIdsBySource(src);
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

            registry.register(channel);
            return {
                deactivate() {
                    channel.teardown();
                    registry.unregister(ctx.node.id);
                },
            };
        },

        receiver(ctx) {
            if (ctx.node.type !== 'channel') return null;
            return (event) => {
                const channel = registry.get(ctx.node.id);
                if (channel) channel.deliver(event);
            };
        },
    };
}
