import { randomUUID } from 'node:crypto';
import type { DispatchEvent, Message } from '@fabritorio/types';

export function newDispatch(args: {
    source: string;
    messages: Message[];
    meta?: Record<string, unknown>;
    parentId?: string;
    now?: () => number;
}): DispatchEvent {
    const now = args.now ?? Date.now;
    const event: DispatchEvent = {
        eventId: randomUUID(),
        source: args.source,
        timestamp: now(),
        messages: args.messages,
        ...(args.parentId ? { parentId: args.parentId } : {}),
        ...(args.meta ? { meta: args.meta } : {}),
    };
    return event;
}

export function childDispatch(
    parent: DispatchEvent,
    args: {
        source?: string;
        messages: Message[];
        meta?: Record<string, unknown>;
        now?: () => number;
    },
): DispatchEvent {
    const mergedMeta = parent.meta || args.meta ? { ...parent.meta, ...args.meta } : undefined;
    return newDispatch({
        source: args.source ?? parent.source,
        messages: args.messages,
        parentId: parent.eventId,
        ...(mergedMeta ? { meta: mergedMeta } : {}),
        ...(args.now ? { now: args.now } : {}),
    });
}
