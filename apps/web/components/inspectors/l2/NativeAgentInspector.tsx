import type { NativeAgentNode, Node } from '@fabritorio/types';
import type { RunnerClient } from '@/lib/runner-client';
import { Label, Input, TextArea, HeaderRow } from '../shared';
import { ConversationsSection } from './ConversationsSection';

export function NativeAgentInspector({
    node,
    onChange,
    onOpenCalls,
    allNodes,
    client,
    currentGraphId,
    onOpenChat,
    onConversationDeleted,
}: {
    node: NativeAgentNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    onOpenCalls?: (nodeId: string) => void;
    allNodes: ReadonlyArray<Node>;
    client?: RunnerClient;
    currentGraphId: string | null;
    onOpenChat?: (agentId: string, convId: string | null) => void;
    onConversationDeleted?: (convId: string) => void;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Native Agent" id={node.id} />
            <ConversationsSection
                agentId={node.id}
                agentNodes={allNodes}
                client={client}
                currentGraphId={currentGraphId}
                onOpenChat={onOpenChat}
                onConversationDeleted={onConversationDeleted}
            />
            {onOpenCalls && (
                <button
                    type="button"
                    onClick={() => onOpenCalls(node.id)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                    View calls
                </button>
            )}
            <div>
                <Label>Display name</Label>
                <Input
                    value={node.display_name ?? ''}
                    onChange={(e) =>
                        onChange(node.id, {
                            display_name: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Description</Label>
                <TextArea
                    rows={2}
                    value={node.description ?? ''}
                    placeholder="What this agent does — shown to callers that delegate to it via ask_agent"
                    onChange={(e) =>
                        onChange(node.id, {
                            description: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>L1 graph id</Label>
                <Input
                    value={node.l1_graph_id}
                    placeholder="paste a saved L1 graph id"
                    onChange={(e) =>
                        onChange(node.id, {
                            l1_graph_id: e.target.value,
                        } as Partial<Node>)
                    }
                />
            </div>
        </div>
    );
}
