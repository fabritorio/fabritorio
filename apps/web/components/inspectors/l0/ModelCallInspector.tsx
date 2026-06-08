import type { ModelCallNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function ModelCallInspector({ node }: { node: ModelCallNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Model Call" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Calls the Model wired to the parent L1 HandlerNode with the current messages buffer.
                Appends the assistant message (with optional tool_calls) and forwards to the next
                node.
            </p>
        </div>
    );
}
