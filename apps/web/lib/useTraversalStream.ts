import type { EdgeTraversedEvent } from '@fabritorio/types';
import type { RunnerClient, StreamSubscription } from './runner-client';
import { publishTraversal } from './traversal-bus';

let activeTraversalSource: StreamSubscription | null = null;

export function subscribeTraversalStream(deps: {
    client: RunnerClient;
    publish?: (e: EdgeTraversedEvent) => void;
}): () => void {
    const publish = deps.publish ?? publishTraversal;
    activeTraversalSource?.close();
    activeTraversalSource = null;
    let closed = false;
    const source = deps.client.animationStream({
        event(ev) {
            if (closed) return;
            publish(ev);
        },
    });
    activeTraversalSource = source;
    return () => {
        closed = true;
        source.close();
        if (activeTraversalSource === source) activeTraversalSource = null;
    };
}
