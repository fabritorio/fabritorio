import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Node } from '@fabritorio/types';
import type { RunnerClient } from '@/lib/runner-client';
import { sidecarChannelIdFor, type AgentConversationSummary } from '@/lib/webchat';
import { formatBytes } from '@/lib/format';
import { Label } from '../shared';

export function ConversationsSection({
    agentId,
    agentNodes,
    client,
    currentGraphId,
    onOpenChat,
    onConversationDeleted,
}: {
    agentId: string;
    agentNodes: ReadonlyArray<Node>;
    client?: RunnerClient;
    currentGraphId: string | null;
    onOpenChat?: (agentId: string, convId: string | null) => void;
    onConversationDeleted?: (convId: string) => void;
}) {
    const [conversations, setConversations] = useState<AgentConversationSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editingConvId, setEditingConvId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');

    const sidecarChannelId = useMemo(
        () => sidecarChannelIdFor({ kind: 'l2', nodes: [...agentNodes], edges: [] }, agentId),
        [agentNodes, agentId],
    );

    const loadOnce = useCallback(async (): Promise<AgentConversationSummary[]> => {
        if (!client || !currentGraphId) return [];
        await client.activateGraph(currentGraphId);
        const res = await client.agentConversations(currentGraphId, agentId);
        return res.conversations;
    }, [agentId, client, currentGraphId]);

    const refresh = useCallback(async () => {
        if (!client || !currentGraphId) return;
        try {
            setConversations(await loadOnce());
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client, currentGraphId, loadOnce]);

    const onDelete = useCallback(
        async (convId: string) => {
            if (!client || !currentGraphId) return;
            if (!window.confirm(`Delete conversation ${convId}? This can't be undone.`)) return;
            try {
                await client.deleteConversation(currentGraphId, agentId, convId);
                onConversationDeleted?.(convId);
                setConversations(await loadOnce());
                setError(null);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [agentId, client, currentGraphId, loadOnce, onConversationDeleted],
    );

    const startRename = useCallback((c: AgentConversationSummary) => {
        setEditingConvId(c.convId);
        setEditValue(c.label ?? c.convId);
    }, []);

    const cancelRename = useCallback(() => {
        setEditingConvId(null);
        setEditValue('');
    }, []);

    const commitRename = useCallback(
        async (convId: string) => {
            if (!client || !currentGraphId) return;
            const value = editValue.trim();
            setEditingConvId(null);
            setEditValue('');
            try {
                await client.renameConversation(currentGraphId, agentId, convId, value);
                setConversations(await loadOnce());
                setError(null);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [agentId, client, currentGraphId, editValue, loadOnce],
    );

    useEffect(() => {
        let cancelled = false;
        if (!client || !currentGraphId) {
            setConversations(null);
            return;
        }
        setError(null);
        void (async () => {
            try {
                const convs = await loadOnce();
                if (!cancelled) {
                    setConversations(convs);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, currentGraphId, loadOnce]);

    return (
        <div className="space-y-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
            <div className="flex items-center justify-between">
                <Label>Conversations</Label>
                <button
                    type="button"
                    disabled={!onOpenChat || !sidecarChannelId}
                    onClick={() => onOpenChat?.(agentId, null)}
                    title={
                        sidecarChannelId
                            ? 'Start a fresh conversation with this agent'
                            : 'Sidecar channel not ready yet'
                    }
                    className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    New chat
                </button>
            </div>
            {error && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    {error}
                    <button type="button" onClick={() => void refresh()} className="ml-1 underline">
                        retry
                    </button>
                </div>
            )}
            {conversations === null && !error ? (
                <p className="text-[10px] text-zinc-500 dark:text-zinc-500">loading…</p>
            ) : conversations && conversations.length === 0 ? (
                <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                    No conversations yet. Start one with “New chat”.
                </p>
            ) : (
                <ul className="space-y-1">
                    {conversations?.map((c) => (
                        <li
                            key={c.convId}
                            className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                            {editingConvId === c.convId ? (
                                <input
                                    type="text"
                                    autoFocus
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            void commitRename(c.convId);
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            cancelRename();
                                        }
                                    }}
                                    onBlur={() => cancelRename()}
                                    placeholder={c.convId}
                                    className="min-w-0 flex-1 rounded-md border border-indigo-300 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 outline-none focus:border-indigo-500 dark:border-indigo-700/60 dark:bg-zinc-900 dark:text-zinc-100"
                                />
                            ) : (
                                <button
                                    type="button"
                                    disabled={!onOpenChat}
                                    onClick={() => onOpenChat?.(agentId, c.convId)}
                                    className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
                                    title={c.convId}
                                >
                                    <span className="truncate font-mono">
                                        {c.label ?? c.convId}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
                                        {formatBytes(c.bytes)}
                                    </span>
                                </button>
                            )}
                            {editingConvId !== c.convId && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        startRename(c);
                                    }}
                                    title="Rename conversation"
                                    aria-label={`Rename conversation ${c.convId}`}
                                    className="shrink-0 rounded-md border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 text-[11px] leading-none text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                >
                                    ✎
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void onDelete(c.convId);
                                }}
                                title="Delete conversation"
                                aria-label={`Delete conversation ${c.convId}`}
                                className="mr-1 shrink-0 rounded-md border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[11px] leading-none text-rose-700 hover:bg-rose-100 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70"
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
