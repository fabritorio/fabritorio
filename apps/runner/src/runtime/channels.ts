import type { DispatchEvent } from '@fabritorio/types';

export interface PublishArgs {
    content: string;
    source?: string;
}

export interface WebchatChannel {
    graphId: string;
    channelNodeId: string;
    publish(args: PublishArgs): Promise<DispatchEvent>;
    subscribe(listener: (event: DispatchEvent) => void): () => void;
    onTeardown(closer: () => void): () => void;
    deliver(event: DispatchEvent): void;
    rootsBySource(source: string): string[];
    teardown(): void;
}

export interface ChannelRegistry {
    register(channel: WebchatChannel): void;
    unregister(channelNodeId: string): void;
    get(channelNodeId: string): WebchatChannel | undefined;
    list(): WebchatChannel[];
}

export function createChannelRegistry(): ChannelRegistry {
    const byId = new Map<string, WebchatChannel>();
    return {
        register(channel) {
            if (byId.has(channel.channelNodeId)) {
                throw new Error(
                    `channel ${channel.channelNodeId} is already registered (graph ${
                        byId.get(channel.channelNodeId)!.graphId
                    })`,
                );
            }
            byId.set(channel.channelNodeId, channel);
        },
        unregister(id) {
            byId.delete(id);
        },
        get(id) {
            return byId.get(id);
        },
        list() {
            return [...byId.values()];
        },
    };
}
