import type { GatewayNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function GatewayInspector({ node }: { node: GatewayNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Gateway" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                The single entrance into an L1 sub-graph. Receives Dispatch events from whatever
                Channel or wrapping NativeAgent is wired in.
            </p>
        </div>
    );
}
