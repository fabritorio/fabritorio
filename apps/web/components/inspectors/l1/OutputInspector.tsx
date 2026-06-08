import type { OutputNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function OutputInspector({ node }: { node: OutputNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Output" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Sole exit. Emits on the named ports <code className="font-mono">result</code> and{' '}
                <code className="font-mono">error</code>; future ports can be added as the L1 grows.
            </p>
        </div>
    );
}
