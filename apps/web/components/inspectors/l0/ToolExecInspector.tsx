import type { ToolExecNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function ToolExecInspector({ node }: { node: ToolExecNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Tool Exec" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Runs each tool_call against the Tools / ToolPacks wired to the parent L1 HandlerNode
                and appends results to the messages buffer.
            </p>
        </div>
    );
}
