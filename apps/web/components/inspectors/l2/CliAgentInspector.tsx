import type { CliAgentNode, Node } from '@fabritorio/types';
import type { RunnerClient } from '@/lib/runner-client';
import { Label, Input, TextArea, HeaderRow } from '../shared';
import { ConversationsSection } from './ConversationsSection';
import { CliInvocationRefPicker } from './CliInvocationRefPicker';

interface CliPreset {
    value: string;
    label: string;
    command: string;
    output_format: NonNullable<CliAgentNode['output_format']>;
}

const CLI_PRESETS: CliPreset[] = [
    { value: 'go-claude', label: 'go-claude', command: 'go-claude', output_format: 'text' },
    { value: 'pi', label: 'pi (pi-coding-agent)', command: 'pi', output_format: 'jsonl' },
    { value: 'claude', label: 'Claude Code', command: 'claude', output_format: 'text' },
    { value: 'codex', label: 'Codex', command: 'codex', output_format: 'text' },
    { value: 'gemini', label: 'Gemini CLI', command: 'gemini', output_format: 'text' },
];

function detectPreset(command: string): string {
    const match = CLI_PRESETS.find((p) => p.command === command);
    return match?.value ?? 'custom';
}

export function CliAgentInspector({
    node,
    onChange,
    client,
    currentGraphId,
    allNodes,
    onOpenChat,
    onConversationDeleted,
}: {
    node: CliAgentNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
    currentGraphId: string | null;
    allNodes: ReadonlyArray<Node>;
    onOpenChat?: (agentId: string, convId: string | null) => void;
    onConversationDeleted?: (convId: string) => void;
}) {
    const presetValue = detectPreset(node.command);
    const isCustom = presetValue === 'custom';

    const onPresetChange = (value: string) => {
        if (value === 'custom') {
            onChange(node.id, { command: '' } as Partial<Node>);
            return;
        }
        const preset = CLI_PRESETS.find((p) => p.value === value);
        if (!preset) return;
        onChange(node.id, {
            command: preset.command,
            output_format: preset.output_format,
        } as Partial<Node>);
    };

    return (
        <div className="space-y-3">
            <HeaderRow label="CLI Agent" id={node.id} />
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
                <Label>Preset</Label>
                <select
                    value={presetValue}
                    onChange={(e) => onPresetChange(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    {CLI_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                            {p.label}
                        </option>
                    ))}
                    <option value="custom">Custom…</option>
                </select>
            </div>
            {isCustom && (
                <div>
                    <Label>Command</Label>
                    <Input
                        value={node.command}
                        placeholder="my-cli"
                        onChange={(e) =>
                            onChange(node.id, { command: e.target.value } as Partial<Node>)
                        }
                    />
                </div>
            )}
            <div>
                <Label>Session mode</Label>
                <select
                    value={node.session_mode}
                    onChange={(e) =>
                        onChange(node.id, {
                            session_mode: e.target.value as CliAgentNode['session_mode'],
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
                defaultName={`${node.command || 'cli'} config`}
                targetDisplayName={node.command || 'cli'}
            />
            <details className="rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
                <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                    Legacy fields (overridden by inner config graph)
                </summary>
                <div className="space-y-3 px-2 pb-2 pt-1">
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
