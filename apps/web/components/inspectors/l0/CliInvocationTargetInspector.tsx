import type { CliInvocationTargetNode, Node } from '@fabritorio/types';
import { HeaderRow, Label, Input } from '../shared';

export function CliInvocationTargetInspector({
    node,
    onChange,
}: {
    node: CliInvocationTargetNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Agent Target" id={node.id} />
            <div>
                <Label>Display name</Label>
                <Input
                    value={node.display_name ?? ''}
                    placeholder="e.g. pi"
                    onChange={(e) =>
                        onChange(node.id, {
                            display_name: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Visual anchor — wire Model / Workspace / Skill nodes into this target to keep the
                canvas readable. Edges are decorative; the runtime walks node fields directly.
            </p>
        </div>
    );
}
