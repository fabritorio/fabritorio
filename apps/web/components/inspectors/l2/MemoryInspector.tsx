import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MemoryNode, Node } from '@fabritorio/types';
import type { MemorySnapshot, RunnerClient } from '@/lib/runner-client';
import { formatBytes, utf8Bytes } from '@/lib/format';
import { MarkdownContent } from '../../MarkdownContent';
import { Label, TextArea, HeaderRow } from '../shared';

function HandlingConfig({
    node,
    onChange,
    readOnly,
}: {
    node: MemoryNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    readOnly?: boolean;
}) {
    const handling = node.handling;
    const selectClass =
        'w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';
    return (
        <>
            <div>
                <Label>Handling</Label>
                <select
                    value={handling}
                    disabled={readOnly}
                    onChange={(e) =>
                        onChange(node.id, {
                            handling: e.target.value as MemoryNode['handling'],
                        } as Partial<Node>)
                    }
                    className={selectClass}
                >
                    <option value="none">none (storage-only)</option>
                    <option value="always_inject">always_inject (every Dispatch)</option>
                    <option value="last_n">last_n (tail window of turns)</option>
                    <option value="last_within_tokens">
                        last_within_tokens (tail window by token budget)
                    </option>
                    <option value="full_history">full_history (replay Message[])</option>
                </select>
            </div>
            {handling === 'last_n' && (
                <div>
                    <Label>n (turns)</Label>
                    <input
                        type="number"
                        min={1}
                        max={200}
                        value={node.n ?? 20}
                        disabled={readOnly}
                        placeholder="20"
                        onChange={(e) => {
                            const raw = e.target.value;
                            const parsed = raw === '' ? 20 : Number(raw);
                            const clamped = Number.isFinite(parsed)
                                ? Math.min(200, Math.max(1, Math.floor(parsed)))
                                : 20;
                            onChange(node.id, { n: clamped } as Partial<Node>);
                        }}
                        className={selectClass}
                    />
                </div>
            )}
            {handling === 'last_within_tokens' && (
                <div>
                    <Label>token_budget (estimated tokens)</Label>
                    <input
                        type="number"
                        min={256}
                        max={200000}
                        value={node.token_budget ?? 8192}
                        disabled={readOnly}
                        placeholder="8192"
                        onChange={(e) => {
                            const raw = e.target.value;
                            const parsed = raw === '' ? 8192 : Number(raw);
                            const clamped = Number.isFinite(parsed)
                                ? Math.min(200000, Math.max(256, Math.floor(parsed)))
                                : 8192;
                            onChange(node.id, { token_budget: clamped } as Partial<Node>);
                        }}
                        className={selectClass}
                    />
                </div>
            )}
        </>
    );
}

export function MemoryInspector({
    node,
    onChange,
    client,
    readOnly,
}: {
    node: MemoryNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
    readOnly?: boolean;
}) {
    const storageKind = node.storage_kind;
    const toolAccess = node.tool_access;
    return (
        <div className="space-y-3">
            <HeaderRow label="Memory" id={node.id} />
            <div>
                <Label>Storage kind</Label>
                <select
                    value={storageKind}
                    disabled={readOnly}
                    onChange={(e) =>
                        onChange(node.id, {
                            storage_kind: e.target.value as MemoryNode['storage_kind'],
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="kv">kv (key-value)</option>
                    <option value="markdown">markdown (single blob)</option>
                    <option value="static_string">static_string (inline)</option>
                </select>
            </div>
            <HandlingConfig node={node} onChange={onChange} readOnly={readOnly} />
            <div>
                <Label>Tool access</Label>
                <select
                    value={toolAccess}
                    disabled={readOnly}
                    onChange={(e) =>
                        onChange(node.id, {
                            tool_access: e.target.value as MemoryNode['tool_access'],
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="none">none</option>
                    <option value="read">read (memory_read)</option>
                    <option value="read_write">read_write (memory_read + memory_write)</option>
                </select>
            </div>
            {storageKind === 'static_string' ? (
                <div>
                    <Label>Content</Label>
                    <TextArea
                        rows={10}
                        value={node.content ?? ''}
                        readOnly={readOnly}
                        placeholder="e.g. The user prefers concise, direct answers. They work in TypeScript and dislike unnecessary comments."
                        onChange={(e) =>
                            onChange(node.id, {
                                content: e.target.value || undefined,
                            } as Partial<Node>)
                        }
                    />
                </div>
            ) : (
                <>
                    <div>
                        <Label>Storage</Label>
                        <select
                            value={node.storage}
                            disabled={readOnly}
                            onChange={(e) =>
                                onChange(node.id, {
                                    storage: e.target.value as MemoryNode['storage'],
                                } as Partial<Node>)
                            }
                            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        >
                            <option value="in_memory">in-memory (RAM only)</option>
                            <option value="local_storage">local storage (file-backed)</option>
                        </select>
                    </div>
                    {client &&
                        (storageKind === 'markdown' ? (
                            <MemoryMarkdownEditor
                                nodeId={node.id}
                                client={client}
                                storage={node.storage}
                                readOnly={readOnly ?? false}
                            />
                        ) : (
                            <MemoryStateView
                                nodeId={node.id}
                                client={client}
                                readOnly={readOnly ?? false}
                            />
                        ))}
                </>
            )}
        </div>
    );
}

function MemoryStateView({
    nodeId,
    client,
    readOnly = false,
}: {
    nodeId: string;
    client: RunnerClient;
    readOnly?: boolean;
}) {
    const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchSnapshot = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await client.getMemory(nodeId);
            setSnapshot(result);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [client, nodeId]);

    useEffect(() => {
        void fetchSnapshot();
    }, [fetchSnapshot]);

    const entries = snapshot ? Object.entries(snapshot.entries) : [];

    return (
        <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Label>State</Label>
                    {snapshot && (
                        <span className="text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                            {formatBytes(utf8Bytes(JSON.stringify(snapshot.entries)))}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => void fetchSnapshot()}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                    {loading ? '…' : 'Refresh'}
                </button>
            </div>
            {error && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    {error}
                </div>
            )}
            {!snapshot ? (
                <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                    (memory not loaded — load the graph by opening the chat panel)
                </p>
            ) : entries.length === 0 ? (
                <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                    (empty — memory has no entries yet)
                </p>
            ) : (
                <div className="space-y-2">
                    {entries.map(([key, value]) =>
                        readOnly ? (
                            <MemoryEntryReadonly key={key} entryKey={key} value={value} />
                        ) : (
                            <MemoryEntryRow
                                key={key}
                                nodeId={nodeId}
                                entryKey={key}
                                value={value}
                                client={client}
                                onChanged={fetchSnapshot}
                            />
                        ),
                    )}
                </div>
            )}
        </div>
    );
}

function MemoryMarkdownEditor({
    nodeId,
    client,
    storage,
    readOnly,
}: {
    nodeId: string;
    client: RunnerClient;
    storage: MemoryNode['storage'];
    readOnly: boolean;
}) {
    const isFile = storage === 'local_storage';
    const [content, setContent] = useState('');
    const [draft, setDraft] = useState('');
    const [mode, setMode] = useState<'preview' | 'edit'>('preview');
    const [loading, setLoading] = useState(true);
    const [notLoaded, setNotLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const fetchContent = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            if (isFile) {
                const f = await client.getMemoryFile(nodeId);
                setContent(f.content);
                setNotLoaded(false);
            } else {
                const snap = await client.getMemory(nodeId);
                if (!snap) {
                    setContent('');
                    setNotLoaded(true);
                    return;
                }
                const c = snap.entries.content;
                setContent(typeof c === 'string' ? c : '');
                setNotLoaded(false);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [client, isFile, nodeId]);

    useEffect(() => {
        void fetchContent();
    }, [fetchContent]);

    useEffect(() => {
        setDraft((prev) => (prev === content ? prev : content));
    }, [content]);

    const dirty = draft !== content;
    const editable = !readOnly && !notLoaded;

    const onSave = useCallback(async () => {
        setBusy(true);
        setSaveError(null);
        try {
            if (isFile) {
                const f = await client.putMemoryFile(nodeId, draft);
                setContent(f.content);
            } else {
                const ok = await client.setMemoryKey(nodeId, 'content', draft);
                if (!ok) {
                    setSaveError('Memory not loaded on the runner');
                    return;
                }
                await fetchContent();
            }
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [client, draft, fetchContent, isFile, nodeId]);

    const onClear = useCallback(async () => {
        setBusy(true);
        setSaveError(null);
        try {
            if (isFile) {
                await client.deleteMemoryFile(nodeId);
                setContent('');
            } else {
                await client.deleteMemoryKey(nodeId, 'content');
                await fetchContent();
            }
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [client, fetchContent, isFile, nodeId]);

    return (
        <div className="space-y-2">
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
                <div className="flex items-center justify-between gap-2 rounded-t-md border-b border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900/60">
                    <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        content{dirty ? ' •' : ''}
                        {!notLoaded && !error && (
                            <span className="ml-2 text-zinc-400 dark:text-zinc-500">
                                {formatBytes(utf8Bytes(content))}
                            </span>
                        )}
                    </span>
                    <div className="flex items-center gap-1">
                        {editable && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setMode('preview')}
                                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                                        mode === 'preview'
                                            ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                                            : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                                    }`}
                                >
                                    Preview
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setMode('edit')}
                                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                                        mode === 'edit'
                                            ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                                            : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                                    }`}
                                >
                                    Edit
                                </button>
                            </>
                        )}
                        <button
                            type="button"
                            onClick={() => void fetchContent()}
                            className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                        >
                            {loading ? '…' : 'Refresh'}
                        </button>
                    </div>
                </div>
                {error ? (
                    <div className="px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
                        {error}
                    </div>
                ) : notLoaded ? (
                    <p className="px-3 py-2 text-[10px] text-zinc-500 dark:text-zinc-500">
                        (memory not loaded — open the chat panel, or switch storage to local storage
                        to edit the file directly)
                    </p>
                ) : readOnly || mode === 'preview' ? (
                    <div className="max-h-72 overflow-auto px-3 py-2">
                        {draft.trim().length > 0 ? (
                            <MarkdownContent content={draft} />
                        ) : (
                            <p className="text-[11px] italic text-zinc-400">(empty)</p>
                        )}
                    </div>
                ) : (
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        spellCheck={false}
                        rows={14}
                        className="block max-h-[80vh] min-h-[8rem] w-full resize-y border-0 bg-white px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-900 focus:outline-none dark:bg-zinc-950 dark:text-zinc-100"
                    />
                )}
            </div>
            {saveError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    {saveError}
                </div>
            )}
            {editable && (
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        disabled={busy || !dirty}
                        onClick={() => void onSave()}
                        className="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                    {dirty && (
                        <button
                            type="button"
                            onClick={() => setDraft(content)}
                            className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                        >
                            Revert
                        </button>
                    )}
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onClear()}
                        className="ml-auto rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70"
                    >
                        Clear
                    </button>
                </div>
            )}
        </div>
    );
}

function MemoryEntryReadonly({ entryKey, value }: { entryKey: string; value: unknown }) {
    const formatted = useMemo(() => JSON.stringify(value, null, 2), [value]);
    return (
        <div className="space-y-1 rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300">
                {entryKey}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-2 font-mono text-[10px] text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                {formatted}
            </pre>
        </div>
    );
}

function MemoryEntryRow({
    nodeId,
    entryKey,
    value,
    client,
    onChanged,
}: {
    nodeId: string;
    entryKey: string;
    value: unknown;
    client: RunnerClient;
    onChanged: () => void | Promise<void>;
}) {
    const initial = useMemo(() => JSON.stringify(value, null, 2), [value]);
    const [draft, setDraft] = useState(initial);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setDraft((prev) => (prev === initial ? prev : initial));
    }, [initial]);

    const dirty = draft !== initial;

    const onSave = useCallback(async () => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(draft);
        } catch (err) {
            setSaveError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        setBusy(true);
        setSaveError(null);
        try {
            const ok = await client.setMemoryKey(nodeId, entryKey, parsed);
            if (!ok) {
                setSaveError('Memory not loaded on the runner');
                return;
            }
            await onChanged();
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [client, draft, entryKey, nodeId, onChanged]);

    const onClear = useCallback(async () => {
        setBusy(true);
        setSaveError(null);
        try {
            await client.deleteMemoryKey(nodeId, entryKey);
            await onChanged();
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [client, entryKey, nodeId, onChanged]);

    return (
        <div className="rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-[10px] text-zinc-700 dark:text-zinc-300">
                    {entryKey}
                </span>
                <div className="flex gap-1">
                    <button
                        type="button"
                        disabled={busy || !dirty}
                        onClick={() => void onSave()}
                        className="rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Save
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onClear()}
                        className="rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70"
                    >
                        Clear
                    </button>
                </div>
            </div>
            <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                rows={Math.min(12, Math.max(3, draft.split('\n').length))}
                className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            {saveError && (
                <div className="mt-1 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    {saveError}
                </div>
            )}
        </div>
    );
}
