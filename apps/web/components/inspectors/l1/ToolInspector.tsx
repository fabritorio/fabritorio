import { useEffect, useState } from 'react';
import type { Node, ToolNode } from '@fabritorio/types';
import type { RunnerClient, ToolSpecSummary } from '@/lib/runner-client';
import { groupToolsBySource } from '@/lib/tool-catalog';
import {
    applyConfigField,
    configFieldValue,
    configSchemaFor,
    enumEmptyOptionLabel,
    visibleConfigFields,
} from '@/lib/tool-config';
import { HeaderRow, Label, Input } from '../shared';

export function ToolInspector({
    node,
    onChange,
    client,
}: {
    node: ToolNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
}) {
    const [tools, setTools] = useState<ToolSpecSummary[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        if (!client) {
            setTools(null);
            return;
        }
        let cancelled = false;
        void client
            .listTools()
            .then((list) => {
                if (!cancelled) setTools(list);
            })
            .catch((err) => {
                if (!cancelled) {
                    setLoadError(err instanceof Error ? err.message : String(err));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [client]);

    const knownNames = new Set(tools?.map((t) => t.name) ?? []);
    const showStaleOption =
        node.tool_name.length > 0 && tools !== null && !knownNames.has(node.tool_name);
    const grouped = tools !== null ? groupToolsBySource(tools) : null;

    return (
        <div className="space-y-3">
            <HeaderRow label="Tool" id={node.id} />
            <div>
                <Label>Tool name</Label>
                {tools === null && !loadError ? (
                    <Input value={node.tool_name} disabled placeholder="loading…" />
                ) : tools === null ? (
                    <Input
                        value={node.tool_name}
                        placeholder="e.g. read_file"
                        onChange={(e) =>
                            onChange(node.id, {
                                tool_name: e.target.value,
                            } as Partial<Node>)
                        }
                    />
                ) : (
                    <select
                        value={node.tool_name}
                        onChange={(e) =>
                            onChange(node.id, {
                                tool_name: e.target.value,
                            } as Partial<Node>)
                        }
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    >
                        <option value="">(select a tool)</option>
                        <optgroup label="Built-in">
                            {grouped!.builtin.map((t) => (
                                <option key={t.name} value={t.name}>
                                    {t.name}
                                </option>
                            ))}
                        </optgroup>
                        {grouped!.runtime.length > 0 && (
                            <optgroup label="Runtime">
                                {grouped!.runtime.map((t) => (
                                    <option key={t.name} value={t.name}>
                                        {t.name}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                        {showStaleOption && (
                            <option value={node.tool_name}>
                                {node.tool_name} (not in catalog)
                            </option>
                        )}
                    </select>
                )}
            </div>
            {loadError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    Tool catalog failed to load: {loadError}
                </div>
            )}
            {tools !== null && <ToolDescription tools={tools} selected={node.tool_name} />}
            {tools !== null && <ToolConfigSection tools={tools} node={node} onChange={onChange} />}
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Wire this node to a Handler to grant the model permission to call the tool. Tools
                are strictly gated.
            </p>
        </div>
    );
}

function ToolConfigSection({
    tools,
    node,
    onChange,
}: {
    tools: ToolSpecSummary[];
    node: ToolNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    const schema = configSchemaFor(tools, node.tool_name);
    const visible = visibleConfigFields(schema, node.config);
    if (visible.length === 0) return null;

    const write = (name: string, value: string) => {
        onChange(node.id, {
            config: applyConfigField(node.config, name, value),
        } as Partial<Node>);
    };

    return (
        <div className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            {visible.map((field) => {
                const value = configFieldValue(node.config, field.name);
                return (
                    <div key={field.name}>
                        <Label>{field.label}</Label>
                        {field.kind === 'enum' ? (
                            <select
                                value={value}
                                onChange={(e) => write(field.name, e.target.value)}
                                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                            >
                                <option value="">{enumEmptyOptionLabel(field)}</option>
                                {(field.options ?? []).map((opt) => (
                                    <option key={opt} value={opt}>
                                        {opt}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <Input
                                value={value}
                                placeholder={field.placeholder}
                                onChange={(e) => write(field.name, e.target.value)}
                            />
                        )}
                        {field.description && (
                            <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-500">
                                {field.description}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function ToolDescription({ tools, selected }: { tools: ToolSpecSummary[]; selected: string }) {
    const match = tools.find((t) => t.name === selected);
    if (!match) return null;
    return (
        <p className="rounded-md bg-zinc-100 px-2 py-1 text-[10px] text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
            {match.description}
        </p>
    );
}
