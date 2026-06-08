'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createRunnerClient, type GraphLiveness, type GraphSummary } from '@/lib/runner-client';
import { createStarterGraph } from '@/lib/graph-bootstrap';
import { collectBundle, installBundle, parseBundleText } from '@/lib/bundle';
import { loadPalette } from '@/lib/palette';
import Link from 'next/link';
import { ThemeToggle } from './ThemeToggle';
import { LivenessBadge, LivenessToggle } from './LivenessControls';

interface Item {
    id: string;
    name: string;
    updated_at: string;
    liveness: GraphLiveness;
}

function relativeTime(iso: string): string {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}

function nameOf(graph: { name?: string }): string {
    return graph.name && graph.name.length > 0 ? graph.name : 'Untitled';
}

export function PickerLanding() {
    const router = useRouter();
    const client = useMemo(() => createRunnerClient(), []);
    const [graphs, setGraphs] = useState<GraphSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await client.listGraphs();
            setGraphs(list);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [client]);

    useEffect(() => {
        void refresh();
        void loadPalette().catch(() => {
            // Network hiccup → keep using the local mirror tables. A retry
            // happens on next call. Surfacing this in the UI would be noise:
            // the local fallback is a complete copy of the same data.
        });
    }, [refresh]);

    const items: Item[] = useMemo(() => {
        const out: Item[] = [];
        for (const g of graphs) {
            if (g.graph.kind !== 'l2') continue;
            if (g.graph.library === true) continue;
            out.push({
                id: g.id,
                name: nameOf(g.graph),
                updated_at: g.updated_at,
                liveness: g.liveness,
            });
        }
        out.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        return out;
    }, [graphs]);

    const onOpen = useCallback(
        (id: string) => {
            router.push(`/graphs/${encodeURIComponent(id)}`);
        },
        [router],
    );

    const onNew = useCallback(async () => {
        try {
            const created = await createStarterGraph(client, 'l2');
            router.push(`/graphs/${encodeURIComponent(created.id)}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client, router]);

    const startRename = useCallback((item: Item) => {
        setRenameValue(item.name);
        setRenamingId(item.id);
    }, []);

    const commitRename = useCallback(
        async (item: Item) => {
            const next = renameValue.trim();
            setRenamingId(null);
            if (!next || next === item.name) return;
            try {
                await client.renameGraph(item.id, { name: next });
                await refresh();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [client, refresh, renameValue],
    );

    const onDuplicate = useCallback(
        async (item: Item) => {
            try {
                const copy = await client.cloneGraph(item.id);
                await client.renameGraph(copy.id, { name: `${item.name} (copy)` }).catch(() => {});
                await refresh();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [client, refresh],
    );

    const onExport = useCallback(
        async (item: Item) => {
            try {
                const bundle = await collectBundle(client, item.id);
                const json = JSON.stringify(bundle, null, 2);
                const safe = item.name.replace(/[^A-Za-z0-9._\- ]+/g, '_');
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${safe}.fabritorio.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [client],
    );

    const onDelete = useCallback(
        async (item: Item) => {
            if (typeof window === 'undefined') return;
            if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) {
                return;
            }
            try {
                await client.deleteGraph(item.id);
                await refresh();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [client, refresh],
    );

    const onImportClick = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const onImportFile = useCallback(
        async (ev: ChangeEvent<HTMLInputElement>) => {
            const file = ev.target.files?.[0];
            ev.target.value = '';
            if (!file) return;
            try {
                const text = await file.text();
                const bundle = parseBundleText(text);
                if (!bundle) {
                    setError('Import failed: file is not a valid Fabritorio bundle.');
                    return;
                }
                const { rootId } = await installBundle(client, bundle, {
                    rootNameSuffix: ' (imported)',
                });
                router.push(`/graphs/${encodeURIComponent(rootId)}`);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [client, router],
    );

    const onStop = useCallback(
        async (item: Item) => {
            await client.stopGraph(item.id).catch(() => {});
            await refresh();
        },
        [client, refresh],
    );

    const onResume = useCallback(
        async (item: Item) => {
            await client.resumeGraph(item.id).catch(() => {});
            await refresh();
        },
        [client, refresh],
    );

    const iconButton =
        'rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200';

    return (
        <div className="grid h-screen w-screen grid-rows-[auto_1fr] bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-baseline gap-4">
                    <Link
                        href="/"
                        className="text-sm font-semibold tracking-wide text-zinc-900 transition hover:text-indigo-700 dark:text-white dark:hover:text-indigo-300"
                    >
                        Fabritorio
                    </Link>
                </div>
                <div className="flex items-center gap-3">
                    <ThemeToggle />
                </div>
            </header>
            <main className="overflow-y-auto p-6">
                <div className="mx-auto max-w-3xl space-y-4">
                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={onImportClick}
                            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            title="Import a .fabritorio.json bundle from disk"
                        >
                            Import bundle
                        </button>
                        <button
                            type="button"
                            onClick={() => void onNew()}
                            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200 dark:hover:bg-emerald-500/20"
                        >
                            + New
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".json,application/json"
                            className="hidden"
                            onChange={(ev) => void onImportFile(ev)}
                        />
                    </div>

                    {error && (
                        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-600/60 dark:bg-rose-950/70 dark:text-rose-200">
                            {error}
                        </div>
                    )}

                    <div className="overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                        {loading && items.length === 0 && (
                            <div className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                                Loading…
                            </div>
                        )}
                        {!loading && items.length === 0 && (
                            <div className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                                Nothing here yet — hit "+ New" to create one.
                            </div>
                        )}
                        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                            {items.map((item) => (
                                <li key={item.id}>
                                    <div className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                                        {renamingId === item.id ? (
                                            <input
                                                autoFocus
                                                value={renameValue}
                                                onChange={(ev) => setRenameValue(ev.target.value)}
                                                onBlur={() => void commitRename(item)}
                                                onKeyDown={(ev) => {
                                                    if (ev.key === 'Enter') void commitRename(item);
                                                    else if (ev.key === 'Escape')
                                                        setRenamingId(null);
                                                }}
                                                className="min-w-0 flex-1 rounded border border-indigo-300 bg-white px-2 py-1 text-sm text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-indigo-500/50 dark:bg-zinc-950 dark:text-zinc-100"
                                            />
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => onOpen(item.id)}
                                                className="flex min-w-0 flex-1 flex-col items-start text-left"
                                            >
                                                <span className="flex w-full items-center gap-2">
                                                    <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                                                        {item.name}
                                                    </span>
                                                    <LivenessBadge liveness={item.liveness} />
                                                </span>
                                                <span className="text-[11px] text-zinc-500 dark:text-zinc-500">
                                                    {relativeTime(item.updated_at)} ·{' '}
                                                    {item.id.slice(0, 8)}
                                                </span>
                                            </button>
                                        )}
                                        <LivenessToggle
                                            liveness={item.liveness}
                                            name={item.name}
                                            onStop={() => onStop(item)}
                                            onResume={() => onResume(item)}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => startRename(item)}
                                            className={iconButton}
                                            aria-label={`Rename ${item.name}`}
                                            title="Rename"
                                        >
                                            ✎
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void onDuplicate(item)}
                                            className={iconButton}
                                            aria-label={`Duplicate ${item.name}`}
                                            title="Duplicate"
                                        >
                                            ⧉
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void onExport(item)}
                                            className={iconButton}
                                            aria-label={`Export ${item.name}`}
                                            title="Export bundle"
                                        >
                                            ⤓
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void onDelete(item)}
                                            className="rounded p-1 text-zinc-400 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-950/60 dark:hover:text-rose-300"
                                            aria-label={`Delete ${item.name}`}
                                            title="Delete this graph"
                                        >
                                            ×
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            </main>
        </div>
    );
}
