import type { HandlerInputNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function HandlerInputInspector({ node }: { node: HandlerInputNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Handler Input" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Boundary node. Inbound messages arrive here when the L1 HandlerNode receives a
                Dispatch.
            </p>
        </div>
    );
}
