'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DispatchEvent, TriggerNode } from '@fabritorio/types';
import { buildChatTurns, chatSource, isUserRootEcho, type ChatTurn } from '@/lib/webchat';
import { type ChannelReplayResult, type LockState, type RunnerClient } from '@/lib/runner-client';
import { useFabritorioStore } from '@/lib/store';
import { ChatTurnView, type TriggerLookup } from '@/components/ChatTurnView';

interface Props {
    graphId: string;
    sidecarChannelId: string;
    agentId: string;
    convId?: string | null;
    agentName?: string;
    client: RunnerClient;
    onLockStateChange?: (state: LockState) => void;
}

export function WebchatPanel({
    graphId,
    sidecarChannelId,
    agentId,
    convId: initialConvId = null,
    agentName,
    client,
    onLockStateChange,
}: Props) {
    const [input, setInput] = useState('');
    const [pending, setPending] = useState(false);
    const [pendingEventId, setPendingEventId] = useState<string | null>(null);
    const [stopping, setStopping] = useState(false);
    const [stoppedEventIds, setStoppedEventIds] = useState<ReadonlySet<string>>(() => new Set());
    const [error, setError] = useState<string | null>(null);
    const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready'>('idle');
    const [replay, setReplay] = useState<ChannelReplayResult | null>(null);
    const [liveReplies, setLiveReplies] = useState<DispatchEvent[]>([]);
    const [convId, setConvId] = useState<string | null>(initialConvId);
    useEffect(() => {
        setConvId(initialConvId);
    }, [initialConvId]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const graphNodes = useFabritorioStore((s) => s.graph.nodes);
    const triggerLookup = useMemo<TriggerLookup>(
        () => (nodeId: string) => {
            const node = graphNodes.find(
                (n): n is TriggerNode => n.type === 'trigger' && n.id === nodeId,
            );
            return node?.display_name;
        },
        [graphNodes],
    );

    const channelSource = convId ? chatSource(agentId, convId) : null;

    useEffect(() => {
        let cancelled = false;
        setLoadState('loading');
        setError(null);
        void (async () => {
            try {
                await client.activateGraph(graphId);
                if (cancelled) return;
                onLockStateChange?.('running');
                setLoadState('ready');
            } catch (err) {
                if (cancelled) return;
                const detail = err instanceof Error ? err.message : String(err);
                setError(`Could not load graph: ${detail}`);
                setLoadState('idle');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, graphId, onLockStateChange]);

    const refetchReplay = useCallback(async () => {
        if (!channelSource) return;
        try {
            const next = await client.channelReplay(sidecarChannelId, channelSource);
            setReplay(next);
            setLiveReplies((prev) =>
                prev.filter((r) => {
                    const root = r.parentId;
                    if (!root) return false;
                    const recorded = next.events.some(
                        (ev) => 'type' in ev && ev.type === 'output.emitted' && ev.eventId === root,
                    );
                    return !recorded;
                }),
            );
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            setError(`Replay fetch failed: ${detail}`);
        }
    }, [channelSource, client, sidecarChannelId]);

    useEffect(() => {
        if (loadState !== 'ready') return;
        void refetchReplay();
    }, [loadState, refetchReplay]);

    useEffect(() => {
        if (loadState !== 'ready') return;
        const source = client.channelStream(sidecarChannelId, (event) => {
            if (isUserRootEcho(event)) {
                setPendingEventId(event.eventId);
                return;
            }
            setLiveReplies((prev) => [...prev, event]);
            void refetchReplay();
        });
        return () => {
            source.close();
        };
    }, [client, sidecarChannelId, loadState, refetchReplay]);

    const turns = useMemo<ChatTurn[]>(() => {
        if (!replay || !channelSource) return [];
        return buildChatTurns(replay, channelSource, liveReplies, stoppedEventIds);
    }, [replay, channelSource, liveReplies, stoppedEventIds]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [turns]);

    const onSend = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            const content = input.trim();
            if (!content) return;
            setPending(true);
            setError(null);
            try {
                const result = await client.channelSendMessage(
                    sidecarChannelId,
                    content,
                    convId ? { convId } : undefined,
                );
                setPendingEventId(result.eventId);
                if (!convId && result.convId) {
                    setConvId(result.convId);
                }
                setInput('');
                await refetchReplay();
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                setError(`Send failed: ${detail}`);
            } finally {
                setPending(false);
                setPendingEventId(null);
                setStopping(false);
            }
        },
        [client, convId, input, refetchReplay, sidecarChannelId],
    );

    const onStop = useCallback(async () => {
        const eventId = pendingEventId;
        if (!eventId) return;
        setStopping(true);
        setStoppedEventIds((prev) => new Set(prev).add(eventId));
        try {
            await client.stopDispatch(eventId);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            setError(`Stop failed: ${detail}`);
            setStopping(false);
        }
    }, [client, pendingEventId]);

    const subtitle = agentName && agentName.length > 0 ? agentName : `agent:${agentId}`;

    return (
        <ChatShell title={convId ? 'Chat' : 'New chat'} subtitle={subtitle} status={loadState}>
            <div ref={scrollRef} className="overflow-y-auto px-3 py-2 text-xs">
                {error && (
                    <div className="mb-2 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                        {error}
                    </div>
                )}
                {turns.length === 0 ? (
                    <div className="text-zinc-400 dark:text-zinc-600">
                        (no messages yet — type below to start)
                    </div>
                ) : (
                    <div className="space-y-3">
                        {turns.map((t, i) => (
                            <ChatTurnView
                                key={`${t.kind}-${t.rootEventId}-${i}`}
                                turn={t}
                                userVariant="indigo"
                                triggerLookup={triggerLookup}
                            />
                        ))}
                    </div>
                )}
            </div>
            <form
                onSubmit={onSend}
                className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800"
            >
                <div className="flex items-end gap-2">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                void onSend(e as unknown as React.FormEvent);
                            }
                        }}
                        placeholder="Message the agent…"
                        rows={2}
                        disabled={loadState !== 'ready' || pending}
                        className="min-h-[44px] flex-1 resize-y rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                    {pending ? (
                        <button
                            type="button"
                            onClick={() => void onStop()}
                            disabled={!pendingEventId || stopping}
                            className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white shadow hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {stopping ? 'Stopping…' : 'Stop'}
                        </button>
                    ) : (
                        <button
                            type="submit"
                            disabled={loadState !== 'ready' || input.trim().length === 0}
                            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            Send
                        </button>
                    )}
                </div>
            </form>
        </ChatShell>
    );
}

function ChatShell({
    title,
    subtitle,
    status,
    children,
}: {
    title: string;
    subtitle?: string;
    status?: 'idle' | 'loading' | 'ready';
    children: React.ReactNode;
}) {
    return (
        <aside className="grid h-full w-full grid-rows-[auto_minmax(0,1fr)_auto] border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                        {title}
                    </span>
                    {subtitle && (
                        <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                            {subtitle}
                        </span>
                    )}
                </div>
                {status && (
                    <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            status === 'ready'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'
                                : status === 'loading'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'
                                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                        }`}
                    >
                        {status}
                    </span>
                )}
            </div>
            {children}
        </aside>
    );
}
