import type { DebugGatewayNode, Node } from '@fabritorio/types';
import { HeaderRow, Label, Input } from '../shared';

export function DebugGatewayInspector({
    node,
    onChange,
}: {
    node: DebugGatewayNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    const mode = node.mode ?? 'live';
    return (
        <div className="space-y-3">
            <HeaderRow label="Debug Gateway" id={node.id} />
            <div>
                <Label>Display name</Label>
                <Input
                    value={node.display_name ?? ''}
                    placeholder="e.g. L1 sandbox"
                    onChange={(e) =>
                        onChange(node.id, {
                            display_name: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Mode</Label>
                <select
                    value={mode}
                    onChange={(e) =>
                        onChange(node.id, {
                            mode: e.target.value as DebugGatewayNode['mode'],
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="live">live (writes commit to wired Memory)</option>
                    <option value="scratch">scratch (writes shadowed, dropped on close)</option>
                </select>
            </div>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Substitutes for a Channel/Trigger/Gateway during a debug session. At L1 the runtime
                drives the wired Handler in-process; at L2 it publishes Dispatches into wired
                Agents. Sessions are ephemeral — nothing persists past graph reload.{' '}
                <span className="italic">scratch</span> mode is reserved (today identical to live).
            </p>
        </div>
    );
}
