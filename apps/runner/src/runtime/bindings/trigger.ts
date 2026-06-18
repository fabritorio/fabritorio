import type { TriggerNode } from '@fabritorio/types';
import { newDispatch } from '../dispatch.js';
import { emitForwardTraversal } from './traversal.js';
import type { NodeBinding } from '../graph-runtime.js';
import type {
    TriggerFire,
    TriggerStrategyHandle,
    TriggerStrategyRegistry,
} from '../triggers/strategy.js';

export interface TriggerBindingDeps {
    strategies: TriggerStrategyRegistry;
}

export function createTriggerBinding(deps: TriggerBindingDeps): NodeBinding {
    return {
        async activate(ctx) {
            if (ctx.node.type !== 'trigger') return null;
            const node = ctx.node as TriggerNode;
            if (node.paused === true) return null;
            const factory = deps.strategies.get(node.trigger_kind);
            if (!factory) {
                throw new Error(
                    `trigger ${node.id}: no strategy registered for kind "${node.trigger_kind}"`,
                );
            }

            const fire: TriggerFire = async (fireCtx) => {
                const content =
                    fireCtx?.message && fireCtx.message.length > 0
                        ? fireCtx.message
                        : (node.instructions ?? '');
                if (content.length === 0) {
                    return null;
                }
                const event = newDispatch({
                    source: fireCtx?.source ?? `trigger:${node.id}`,
                    messages: [{ role: 'user', content }],
                    ...(fireCtx?.meta ? { meta: fireCtx.meta } : {}),
                });
                ctx.bus.emitDispatch(event);
                await Promise.all(
                    ctx.outgoing.map((edge) => {
                        emitForwardTraversal(ctx, edge, event.eventId);
                        return ctx.bus.publish(ctx.topicFor(edge), event);
                    }),
                );
                return event;
            };

            const strategy = factory({ node, nodeId: node.id, fire });
            const handle: TriggerStrategyHandle = await strategy.activate();
            return {
                async deactivate() {
                    await handle.deactivate();
                },
            };
        },
    };
}
