'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DispatchEvent } from '@fabritorio/types';
import { buildChatTurns, type ChatTurn } from '@/lib/webchat';
import { type ChannelReplayResult, type LockState, type RunnerClient } from '@/lib/runner-client';
import { ChatTurnView } from '@/components/ChatTurnView';

interface Props {
    graphId: string;
    debugNodeId: string;
    displayName?: string;
    client: RunnerClient;
    onLockStateChange?: (state: LockState) => void;
}

export function DebugGatewayPanel({
    graphId,
    debugNodeId,
    displayName,
    client,
    onLockStateChange,
}: Props) {
    const [input, setInput] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready'>('idle');
    const [replay, setReplay] = useState<ChannelReplayResult | null>(null);
    const [liveReplies, setLiveReplies] = useState<DispatchEvent[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);

    const debugSource = useMemo(() => `debug:${debugNodeId}`, [debugNodeId]);

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
        try {
            const next = await client.debugReplay(graphId, debugNodeId, debugSource);
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
    }, [client, graphId, debugNodeId, debugSource]);

    useEffect(() => {
        if (loadState !== 'ready') return;
        void refetchReplay();
    }, [loadState, refetchReplay]);

    useEffect(() => {
        if (loadState !== 'ready') return;
        const source = client.debugStream(graphId, debugNodeId, (event) => {
            setLiveReplies((prev) => [...prev, event]);
            void refetchReplay();
        });
        return () => {
            source.close();
        };
    }, [client, graphId, debugNodeId, loadState, refetchReplay]);

    const turns = useMemo<ChatTurn[]>(() => {
        if (!replay) return [];
        return buildChatTurns(replay, debugSource, liveReplies);
    }, [replay, debugSource, liveReplies]);

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
                await client.debugSendMessage(graphId, debugNodeId, content);
                setInput('');
                await refetchReplay();
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                setError(`Send failed: ${detail}`);
            } finally {
                setPending(false);
            }
        },
        [client, graphId, debugNodeId, input, refetchReplay],
    );

    const subtitle = displayName && displayName.length > 0 ? displayName : `debug:${debugNodeId}`;

    return (
        <DebugShell title="Debug" subtitle={subtitle} status={loadState}>
            <div ref={scrollRef} className="overflow-y-auto px-3 py-2 text-xs">
                {error && (
                    <div className="mb-2 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                        {error}
                    </div>
                )}
                {turns.length === 0 ? (
                    <div className="text-zinc-400 dark:text-zinc-600">
                        (no messages yet — drive the graph from below)
                    </div>
                ) : (
                    <div className="space-y-3">
                        {turns.map((t, i) => (
                            <ChatTurnView
                                key={`${t.kind}-${t.rootEventId}-${i}`}
                                turn={t}
                                userVariant="fuchsia"
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
                        placeholder="Inject a message into the graph…"
                        rows={2}
                        disabled={loadState !== 'ready' || pending}
                        className="min-h-[44px] flex-1 resize-y rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:outline-none focus:ring-1 focus:ring-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                    <button
                        type="submit"
                        disabled={loadState !== 'ready' || pending || input.trim().length === 0}
                        className="rounded-md bg-fuchsia-600 px-3 py-1.5 text-xs font-medium text-white shadow hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {pending ? 'Sending…' : 'Send'}
                    </button>
                </div>
            </form>
        </DebugShell>
    );
}

function DebugShell({
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
                    <span className="text-[10px] uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-300">
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
                                ? 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-200'
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
