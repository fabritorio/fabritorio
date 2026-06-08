import type { HandlerOutputNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function HandlerOutputInspector({ node }: { node: HandlerOutputNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Handler Output" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Boundary node. Emits the final assistant message via{' '}
                <code className="font-mono">result</code> / <code className="font-mono">error</code>{' '}
                ports.
            </p>
        </div>
    );
}
