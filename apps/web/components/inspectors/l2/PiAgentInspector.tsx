import type { Node, PiAgentNode } from '@fabritorio/types';
import type { RunnerClient } from '@/lib/runner-client';
import { Label, Input, TextArea, HeaderRow } from '../shared';
import { ConversationsSection } from './ConversationsSection';
import { CliInvocationRefPicker } from './CliInvocationRefPicker';

export function PiAgentInspector({
    node,
    onChange,
    client,
    currentGraphId,
    allNodes,
    onOpenChat,
    onConversationDeleted,
}: {
    node: PiAgentNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
    currentGraphId: string | null;
    allNodes: ReadonlyArray<Node>;
    onOpenChat?: (agentId: string, convId: string | null) => void;
    onConversationDeleted?: (convId: string) => void;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Pi Agent" id={node.id} />
            <ConversationsSection
                agentId={node.id}
                agentNodes={allNodes}
                client={client}
                currentGraphId={currentGraphId}
                onOpenChat={onOpenChat}
                onConversationDeleted={onConversationDeleted}
            />
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
                <Label>Command</Label>
                <Input
                    value={node.command ?? ''}
                    placeholder="pi"
                    onChange={(e) =>
                        onChange(node.id, {
                            command: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Session mode</Label>
                <select
                    value={node.session_mode}
                    onChange={(e) =>
                        onChange(node.id, {
                            session_mode: e.target.value as PiAgentNode['session_mode'],
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="session-aware">session-aware</option>
                    <option value="stateless">stateless</option>
                </select>
            </div>
            <CliInvocationRefPicker
                node={node}
                onChange={onChange}
                client={client}
                currentGraphId={currentGraphId}
                defaultName={`${node.command || 'pi'} config`}
                targetDisplayName={node.command || 'pi'}
            />
            <details className="rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
                <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                    Legacy fields (overridden by inner config graph)
                </summary>
                <div className="space-y-3 px-2 pb-2 pt-1">
                    <div>
                        <Label>Provider (optional)</Label>
                        <Input
                            value={node.provider ?? ''}
                            placeholder="anthropic | openai | google | xai | groq | …"
                            onChange={(e) =>
                                onChange(node.id, {
                                    provider: e.target.value || undefined,
                                } as Partial<Node>)
                            }
                        />
                    </div>
                    <div>
                        <Label>Model (optional)</Label>
                        <Input
                            value={node.model ?? ''}
                            placeholder="sonnet | openai/gpt-4o | …"
                            onChange={(e) =>
                                onChange(node.id, {
                                    model: e.target.value || undefined,
                                } as Partial<Node>)
                            }
                        />
                    </div>
                    <div>
                        <Label>Working directory (optional)</Label>
                        <Input
                            value={node.cwd ?? ''}
                            placeholder="defaults to wired Workspace path"
                            onChange={(e) =>
                                onChange(node.id, {
                                    cwd: e.target.value || undefined,
                                } as Partial<Node>)
                            }
                        />
                    </div>
                </div>
            </details>
        </div>
    );
}
