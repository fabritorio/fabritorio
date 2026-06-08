import { useCallback, useEffect, useState } from 'react';
import type { CliAgentNode, Node, PiAgentNode } from '@fabritorio/types';
import type { GraphSummary, RunnerClient } from '@/lib/runner-client';
import { createCliInvocationGraph } from '@/lib/cli-invocation-bootstrap';
import { useDrillNavigation } from '@/lib/useDrillNavigation';
import { Label, Input } from '../shared';

interface CliInvocationRefPickerProps {
    node: CliAgentNode | PiAgentNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
    currentGraphId: string | null;
    defaultName: string;
    targetDisplayName?: string;
}

export function CliInvocationRefPicker({
    node,
    onChange,
    client,
    currentGraphId,
    defaultName,
    targetDisplayName,
}: CliInvocationRefPickerProps) {
    const { drillInto } = useDrillNavigation();
    const [graphs, setGraphs] = useState<GraphSummary[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const refreshCatalog = useCallback(async () => {
        if (!client) return;
        try {
            const list = await client.listGraphs({ kind: 'cli_invocation' });
            setGraphs(list);
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);

    useEffect(() => {
        if (!client) {
            setGraphs(null);
            return;
        }
        let cancelled = false;
        void client
            .listGraphs({ kind: 'cli_invocation' })
            .then((list) => {
                if (!cancelled) setGraphs(list);
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

    const openInner = useCallback(
        (innerId: string) => {
            if (!currentGraphId) return;
            void drillInto(innerId);
        },
        [currentGraphId, drillInto],
    );

    const onCreateAndOpen = useCallback(async () => {
        if (!client) return;
        setBusy(true);
        setActionError(null);
        try {
            const created = await createCliInvocationGraph(client, {
                defaultName,
                targetDisplayName,
            });
            onChange(node.id, { ref_id: created.id } as Partial<Node>);
            void refreshCatalog();
            openInner(created.id);
        } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [client, defaultName, node.id, onChange, openInner, refreshCatalog, targetDisplayName]);

    const visibleGraphs = graphs ?? [];
    const visibleIds = new Set(visibleGraphs.map((g) => g.id));
    const refId = node.ref_id ?? '';
    const showStaleOption = refId.length > 0 && graphs !== null && !visibleIds.has(refId);

    return (
        <div className="space-y-2">
            <div>
                <Label>Inner config graph</Label>
                {graphs === null && !loadError ? (
                    <Input value={refId} disabled placeholder="loading…" />
                ) : graphs === null ? (
                    <Input
                        value={refId}
                        placeholder="(none — create one below)"
                        onChange={(e) =>
                            onChange(node.id, {
                                ref_id: e.target.value || undefined,
                            } as Partial<Node>)
                        }
                    />
                ) : (
                    <select
                        value={refId}
                        onChange={(e) =>
                            onChange(node.id, {
                                ref_id: e.target.value || undefined,
                            } as Partial<Node>)
                        }
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    >
                        <option value="">(none — create one below)</option>
                        {visibleGraphs.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.graph.name?.trim() || g.id.slice(0, 8)}
                            </option>
                        ))}
                        {showStaleOption && (
                            <option value={refId}>{refId} (graph not found)</option>
                        )}
                    </select>
                )}
            </div>
            {loadError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    Config graph list failed to load: {loadError}
                </div>
            )}
            <div className="flex flex-wrap gap-2">
                {refId.length > 0 && (
                    <button
                        type="button"
                        disabled={!currentGraphId}
                        onClick={() => openInner(refId)}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                    >
                        Open config graph
                    </button>
                )}
                <button
                    type="button"
                    disabled={busy || !client || !currentGraphId}
                    onClick={() => void onCreateAndOpen()}
                    className="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy
                        ? 'Creating…'
                        : refId.length > 0
                          ? 'Replace with new config'
                          : 'Create + open config'}
                </button>
                <button
                    type="button"
                    disabled={!client}
                    onClick={() => void refreshCatalog()}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                    Refresh
                </button>
            </div>
            {actionError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    {actionError}
                </div>
            )}
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Config envelope. Drop a Model (provider + model_id), Workspace (cwd), and any Skills
                inside; this agent translates them into invocation flags. The graph is read at
                Dispatch time — it is not executed as a graph.
            </p>
        </div>
    );
}
