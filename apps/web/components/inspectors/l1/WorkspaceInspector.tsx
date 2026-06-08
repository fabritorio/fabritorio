import type { Node, WorkspaceNode } from '@fabritorio/types';
import { HeaderRow, Label, Input } from '../shared';

export function WorkspaceInspector({
    node,
    onChange,
}: {
    node: WorkspaceNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Workspace" id={node.id} />
            <div>
                <Label>Path</Label>
                <Input
                    value={node.path}
                    placeholder="/absolute/path or ./relative"
                    onChange={(e) => onChange(node.id, { path: e.target.value } as Partial<Node>)}
                />
            </div>
            <div>
                <Label>Permissions</Label>
                <div className="flex gap-2 text-xs text-zinc-800 dark:text-zinc-200">
                    <label className="flex items-center gap-1">
                        <input
                            type="radio"
                            name={`perm-${node.id}`}
                            checked={node.permissions === 'read-write'}
                            onChange={() =>
                                onChange(node.id, {
                                    permissions: 'read-write',
                                } as Partial<Node>)
                            }
                        />
                        read-write
                    </label>
                    <label className="flex items-center gap-1">
                        <input
                            type="radio"
                            name={`perm-${node.id}`}
                            checked={node.permissions === 'read'}
                            onChange={() =>
                                onChange(node.id, { permissions: 'read' } as Partial<Node>)
                            }
                        />
                        read-only
                    </label>
                </div>
            </div>
        </div>
    );
}
