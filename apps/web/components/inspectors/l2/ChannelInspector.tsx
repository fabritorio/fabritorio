import type { ChannelNode, Node } from '@fabritorio/types';
import { HeaderRow, Label, Input } from '../shared';

export function ChannelInspector({
    node,
    onChange,
}: {
    node: ChannelNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Channel" id={node.id} />
            <div>
                <Label>Display name</Label>
                <Input
                    value={node.display_name ?? ''}
                    placeholder="e.g. Inbound chat"
                    onChange={(e) =>
                        onChange(node.id, {
                            display_name: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Webchat is the only channel kind today. Discord/WhatsApp etc. are out of scope for
                v0.
            </p>
        </div>
    );
}
