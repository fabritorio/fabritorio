import type { HandlerNode, Node } from '@fabritorio/types';
import { HeaderRow, Label, Input, parseOptionalNumber } from '../shared';

export function HandlerInspector({
    node,
    onChange,
}: {
    node: HandlerNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Handler" id={node.id} />
            <div>
                <Label>Name (optional)</Label>
                <Input
                    value={node.name ?? ''}
                    placeholder="e.g. simple-handler"
                    onChange={(e) =>
                        onChange(node.id, {
                            name: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Max iterations</Label>
                <Input
                    type="number"
                    min={1}
                    value={node.max_iterations ?? ''}
                    placeholder="8"
                    onChange={(e) =>
                        onChange(node.id, {
                            max_iterations: parseOptionalNumber(e.target.value),
                        } as Partial<Node>)
                    }
                />
            </div>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Owns the in-flight Dispatch messages buffer and runs the strategy graph
                synchronously. v0 ships SimpleHandler (ReAct) as code.
            </p>
        </div>
    );
}
