import type { Node, ToolPackNode } from '@fabritorio/types';
import { HeaderRow, Label, Input } from '../shared';
import { PackRefPicker } from './PackRefPicker';

export function ToolPackInspector({
    node,
    onChange,
    currentGraphId,
}: {
    node: ToolPackNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    currentGraphId: string | null;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Tool Pack" id={node.id} />
            <div>
                <Label>Pack name</Label>
                <Input
                    value={node.pack_name ?? ''}
                    placeholder="e.g. basic-io, code-agent"
                    onChange={(e) =>
                        onChange(node.id, {
                            pack_name: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <PackRefPicker node={node} currentGraphId={currentGraphId} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                A pack expands into the Tool nodes inside its L0 graph when wired to a Handler.
                Double-click the node on the canvas to drill in.
            </p>
        </div>
    );
}
