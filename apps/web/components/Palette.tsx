'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { GraphKind, Node } from '@fabritorio/types';
import {
    classifyLibraryEntry,
    hiddenFragmentRefIds,
    paletteKindsForGraphKind,
    type HandlerPaletteKind,
    type L1PaletteKind,
    type L2PaletteKind,
    type PaletteKind,
    type SavedRefKind,
    type SkillPackPaletteKind,
    type ToolPackPaletteKind,
} from '@/lib/node-factory';
import { createRunnerClient, type GraphSummary } from '@/lib/runner-client';
import { kindColorClasses, nodeFamily, type Family } from '@/lib/node-color';

const DRAG_MIME = 'application/x-fabritorio-palette';
const LIBRARY_DRAG_MIME = 'application/x-fabritorio-library';

const L2_SYSTEM_LIBRARY_IDS = new Set<string>([
    '00000000-0000-4000-8000-0000000f0002', // Foreman agent
    '00000000-0000-4000-8000-0000000c0004', // Tool builder agent
    '00000000-0000-4000-8000-0000000c0005', // Skill builder agent
]);

interface Item {
    kind: PaletteKind;
    label: string;
    hint: string;
}

const TOOLPACK_ITEMS: Array<Item & { kind: ToolPackPaletteKind }> = [
    {
        kind: 'tool',
        label: 'Tool',
        hint: 'single tool primitive in the pack',
    },
    {
        kind: 'tool_pack',
        label: 'Tool Pack',
        hint: 'nested pack reference',
    },
];

const SKILLPACK_ITEMS: Array<Item & { kind: SkillPackPaletteKind }> = [
    {
        kind: 'skill',
        label: 'Skill',
        hint: 'single skill primitive in the pack',
    },
    {
        kind: 'skill_pack',
        label: 'Skill Pack',
        hint: 'nested pack reference',
    },
];

const HANDLER_ITEMS: Array<Item & { kind: HandlerPaletteKind }> = [
    {
        kind: 'handler_input',
        label: 'Handler Input',
        hint: 'boundary · inbound messages enter here',
    },
    {
        kind: 'debug_probe',
        label: 'Debug Probe',
        hint: 'tap a primitive · halt + resume (display in v0)',
    },
    {
        kind: 'prompt_builder',
        label: 'Prompt Builder',
        hint: 'system prompt + skills + inbound → buffer',
    },
    {
        kind: 'model_call',
        label: 'Model Call',
        hint: 'calls wired Model with messages buffer',
    },
    {
        kind: 'evaluator',
        label: 'Evaluator',
        hint: 'branch · tools? loop : done',
    },
    {
        kind: 'tool_exec',
        label: 'Tool Exec',
        hint: 'runs tool_calls against wired Tools',
    },
    {
        kind: 'handler_output',
        label: 'Handler Output',
        hint: 'boundary · result/error ports',
    },
];

const L1_ITEMS: Array<Item & { kind: L1PaletteKind }> = [
    {
        kind: 'debug_gateway',
        label: 'Debug Gateway',
        hint: 'drive the L1 from inspector chat (no L2 needed)',
    },
    {
        kind: 'debug_probe',
        label: 'Debug Probe',
        hint: 'tap a node · halt at boundary + resume',
    },
    {
        kind: 'handler',
        label: 'Handler',
        hint: 'central engine · ReAct loop',
    },
    {
        kind: 'model',
        label: 'Model',
        hint: 'LLM call',
    },
    {
        kind: 'model_router',
        label: 'Model Router',
        hint: 'fall over across wired Models · failover policy',
    },
    {
        kind: 'skill',
        label: 'Skill',
        hint: 'permission gate for a SKILL.md',
    },
    {
        kind: 'skill_pack',
        label: 'Skill Pack',
        hint: 'bundle of skills',
    },
    {
        kind: 'tool',
        label: 'Tool',
        hint: 'permission gate for a single tool',
    },
    {
        kind: 'tool_pack',
        label: 'Tool Pack',
        hint: 'bundle of tools',
    },
    {
        kind: 'permission',
        label: 'Permission',
        hint: 'gate tool calls · ask user for allow/deny',
    },
    {
        kind: 'checkpoint',
        label: 'Checkpoint',
        hint: 'meta-cognition · pause + consult a strategy agent',
    },
    {
        kind: 'workspace',
        label: 'Workspace',
        hint: 'filesystem scope for fs tools',
    },
    {
        kind: 'secrets',
        label: 'Secrets',
        hint: 'scoped credentials · wire to a tool',
    },
];

const L2_ITEMS: Array<Item & { kind: L2PaletteKind }> = [
    {
        kind: 'trigger',
        label: 'Trigger',
        hint: 'event source · cron',
    },
    {
        kind: 'schedule',
        label: 'Schedule',
        hint: 'time-based source · once / recurring',
    },
    {
        kind: 'native_agent',
        label: 'Native Agent',
        hint: 'wraps a saved L1 sub-graph',
    },
    {
        kind: 'memory',
        label: 'Memory',
        hint: 'wire to agents · controls what the model sees and what tools touch',
    },
    {
        kind: 'debug_gateway',
        label: 'Debug Gateway',
        hint: 'inject Dispatches without a Channel — ephemeral',
    },
    {
        kind: 'debug_probe',
        label: 'Debug Probe',
        hint: 'tap an Agent · halt at boundary + resume',
    },
];

const FAMILY_ORDER: Family[] = [
    'boundary',
    'control',
    'agent',
    'prompt',
    'model',
    'tool',
    'skill',
    'trigger',
    'workspace',
    'memory',
    'permission',
    'secrets',
    'debug',
];

const FAMILY_LABEL: Record<Family, string> = {
    boundary: 'Boundary',
    control: 'Control',
    agent: 'Agents',
    prompt: 'Prompt',
    model: 'Model',
    tool: 'Tools',
    skill: 'Skills',
    trigger: 'Triggers',
    workspace: 'Workspace',
    memory: 'Memory',
    permission: 'Permission',
    secrets: 'Secrets',
    debug: 'Debug',
};

interface Props {
    graphKind: GraphKind;
    libraryRefreshKey?: number;
}

type LibraryDropTarget =
    | { kind: 'wrapper'; entry: GraphSummary; savedKind: SavedRefKind }
    | { kind: 'leaf'; entry: GraphSummary; leafType: Node['type'] }
    | { kind: 'inline-multi'; entry: GraphSummary };

export function Palette({ graphKind, libraryRefreshKey = 0 }: Props) {
    const client = useMemo(() => createRunnerClient(), []);
    const [libraryEntries, setLibraryEntries] = useState<GraphSummary[]>([]);
    const [localRefresh, setLocalRefresh] = useState(0);
    const [menu, setMenu] = useState<{ x: number; y: number; entry: GraphSummary } | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [confirmDelete, setConfirmDelete] = useState<GraphSummary | null>(null);
    const [librarySearch, setLibrarySearch] = useState('');
    const [librarySort, setLibrarySort] = useState<'name' | 'modified'>('name');

    useEffect(() => {
        let cancelled = false;
        void client
            .listGraphs()
            .then((all) => {
                if (cancelled) return;
                setLibraryEntries(all.filter((g) => g.graph.library === true));
            })
            .catch(() => {
                // Silent: an empty Library section is the right fallback when
                // the runner is unreachable.
            });
        return () => {
            cancelled = true;
        };
    }, [client, libraryRefreshKey, localRefresh]);

    useEffect(() => {
        if (!menu) return;
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') setMenu(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [menu]);

    const startRename = (entry: GraphSummary) => {
        setMenu(null);
        setRenameValue(libraryLabel(entry));
        setRenamingId(entry.id);
    };

    const commitRename = (entry: GraphSummary) => {
        const next = renameValue.trim();
        setRenamingId(null);
        if (!next || next === libraryLabel(entry)) return;
        void client
            .renameGraph(entry.id, { name: next })
            .then(() => setLocalRefresh((n) => n + 1))
            .catch(() => {
                // Silent: the entry keeps its old name on failure; the next
                // re-fetch reconciles. A 403 (system seed) can't happen here —
                // the menu is suppressed for those.
            });
    };

    const performDelete = (entry: GraphSummary) => {
        setConfirmDelete(null);
        void client
            .deleteGraph(entry.id)
            .catch(() => {
                // Silent: a failed delete leaves the entry in place; the
                // re-fetch reconciles either way.
            })
            .finally(() => setLocalRefresh((n) => n + 1));
    };

    const droppableLibrary = useMemo<LibraryDropTarget[]>(() => {
        const hidden = hiddenFragmentRefIds(libraryEntries.map((e) => e.graph));
        const out: LibraryDropTarget[] = [];
        for (const entry of libraryEntries) {
            if (entry.id && hidden.has(entry.id)) continue;
            if (entry.graph.system === true) {
                if (graphKind === 'l2') {
                    if (!L2_SYSTEM_LIBRARY_IDS.has(entry.id ?? '')) continue;
                } else {
                    continue;
                }
            }
            const cls = classifyLibraryEntry(entry.graph, graphKind);
            if (!cls) continue;
            if (cls.kind === 'leaf') {
                out.push({ kind: 'leaf', entry, leafType: cls.leafType });
            } else if (cls.kind === 'inline-multi') {
                out.push({ kind: 'inline-multi', entry });
            } else {
                out.push({ kind: 'wrapper', entry, savedKind: cls.savedKind });
            }
        }
        out.sort((a, b) => libraryLabel(a.entry).localeCompare(libraryLabel(b.entry)));
        return out;
    }, [libraryEntries, graphKind]);

    const allowed = paletteKindsForGraphKind(graphKind);
    const source: Array<Item> =
        graphKind === 'toolpack'
            ? TOOLPACK_ITEMS
            : graphKind === 'skillpack'
              ? SKILLPACK_ITEMS
              : graphKind === 'handler'
                ? HANDLER_ITEMS
                : graphKind === 'l1'
                  ? L1_ITEMS
                  : L2_ITEMS;
    const items = source.filter((item) => allowed.has(item.kind));

    const groups = (() => {
        const byFamily = new Map<Family, Item[]>();
        for (const item of items) {
            const fam = nodeFamily(item.kind);
            const arr = byFamily.get(fam);
            if (arr) arr.push(item);
            else byFamily.set(fam, [item]);
        }
        return FAMILY_ORDER.filter((f) => byFamily.has(f)).map((f) => ({
            family: f,
            label: FAMILY_LABEL[f],
            items: byFamily.get(f)!,
        }));
    })();
    const showGroupHeaders = groups.length > 1;

    const q = librarySearch.trim().toLowerCase();
    const filteredLibrary = q
        ? droppableLibrary.filter((t) => {
              const name = libraryLabel(t.entry).toLowerCase();
              const desc = (t.entry.graph.description ?? '').toLowerCase();
              return name.includes(q) || desc.includes(q);
          })
        : droppableLibrary;
    const sortedLibrary = [...filteredLibrary].sort((a, b) =>
        librarySort === 'modified'
            ? (b.entry.graph.updated_at ?? '').localeCompare(a.entry.graph.updated_at ?? '')
            : libraryLabel(a.entry).localeCompare(libraryLabel(b.entry)),
    );
    const showLibrarySearch = droppableLibrary.length > 4;
    const showLibrarySort = droppableLibrary.length > 1;

    const headerLabel =
        graphKind === 'toolpack'
            ? 'Tool Pack Palette'
            : graphKind === 'skillpack'
              ? 'Skill Pack Palette'
              : graphKind === 'handler'
                ? 'Handler Palette'
                : graphKind === 'l1'
                  ? 'L1 Palette'
                  : 'L2 Palette';
    const footerHint =
        graphKind === 'toolpack'
            ? 'Drop Tool nodes to populate this pack. The L1 ToolPack referencing this graph exposes them all to its Handler.'
            : graphKind === 'skillpack'
              ? 'Drop Skill nodes to populate this pack. The L1 SkillPack referencing this graph exposes them all to its Handler.'
              : graphKind === 'handler'
                ? 'Wire Handler Input → Prompt Builder → Model Call → Evaluator → Tool Exec / Handler Output. Loop tool_exec back into model_call.'
                : graphKind === 'l1'
                  ? 'Gateway → Handler → Output (Gateway/Output ship with the starter). Drag a Handler/Model/Tool/Skill/Workspace and wire it between them.'
                  : 'Channel/Trigger → NativeAgent → Channel. Wire Memory as a side reference.';

    const onDragStart = (ev: DragEvent<HTMLDivElement>, itemKind: PaletteKind) => {
        ev.dataTransfer.setData(DRAG_MIME, itemKind);
        ev.dataTransfer.effectAllowed = 'copy';
    };

    const onLibraryDragStart = (ev: DragEvent<HTMLDivElement>, templateId: string) => {
        ev.dataTransfer.setData(LIBRARY_DRAG_MIME, templateId);
        ev.dataTransfer.effectAllowed = 'copy';
    };

    return (
        <aside className="flex h-full w-full flex-col gap-2 overflow-y-auto border-r border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {headerLabel}
            </div>
            {groups.map((group) => (
                <div key={group.family} className="flex flex-col gap-2">
                    {showGroupHeaders && (
                        <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                            {group.label}
                        </div>
                    )}
                    {group.items.map((item) => (
                        <div
                            key={item.kind}
                            draggable
                            onDragStart={(ev) => onDragStart(ev, item.kind)}
                            className={`cursor-grab select-none rounded-md border px-3 py-2 shadow-sm active:cursor-grabbing ${kindColorClasses(item.kind, 'palette')}`}
                        >
                            <div className="text-[10px] uppercase tracking-wider opacity-70">
                                {item.label}
                            </div>
                            <div className="text-xs opacity-60">{item.hint}</div>
                        </div>
                    ))}
                </div>
            ))}

            {droppableLibrary.length > 0 && (
                <>
                    <div className="mt-3 border-t border-zinc-200 pt-3 text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        Library
                    </div>
                    {showLibrarySearch && (
                        <input
                            type="text"
                            value={librarySearch}
                            onChange={(ev) => setLibrarySearch(ev.target.value)}
                            placeholder="Search library…"
                            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        />
                    )}
                    {showLibrarySort && (
                        <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                            <span className="uppercase tracking-wider">Sort</span>
                            <div className="flex overflow-hidden rounded border border-zinc-300 dark:border-zinc-700">
                                {(
                                    [
                                        ['name', 'Name'],
                                        ['modified', 'Modified'],
                                    ] as const
                                ).map(([key, label]) => (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => setLibrarySort(key)}
                                        className={`px-2 py-0.5 ${
                                            librarySort === key
                                                ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200'
                                                : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {filteredLibrary.length === 0 && (
                        <div className="px-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                            No matches.
                        </div>
                    )}
                    {sortedLibrary.map((target) => {
                        const { entry } = target;
                        const dropsLabel =
                            target.kind === 'wrapper'
                                ? wrapperLabelFor(target.savedKind)
                                : target.kind === 'inline-multi'
                                  ? `${entry.graph.nodes.length} nodes`
                                  : target.leafType;
                        const manageable = entry.graph.system !== true;
                        const isRenaming = renamingId === entry.id;
                        return (
                            <div
                                key={entry.id}
                                draggable={!isRenaming}
                                onDragStart={(ev) => onLibraryDragStart(ev, entry.id)}
                                onContextMenu={(ev) => {
                                    if (!manageable) return;
                                    ev.preventDefault();
                                    setMenu({ x: ev.clientX, y: ev.clientY, entry });
                                }}
                                title={
                                    manageable
                                        ? (entry.graph.description ??
                                          `Drop to add as ${dropsLabel} · right-click to manage`)
                                        : (entry.graph.description ??
                                          `Drop to add as ${dropsLabel}`)
                                }
                                className="cursor-grab select-none rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 shadow-sm active:cursor-grabbing dark:border-zinc-700 dark:bg-zinc-800/60"
                            >
                                <div className="flex items-center gap-2">
                                    {isRenaming ? (
                                        <input
                                            autoFocus
                                            value={renameValue}
                                            onChange={(ev) => setRenameValue(ev.target.value)}
                                            onClick={(ev) => ev.stopPropagation()}
                                            onPointerDown={(ev) => ev.stopPropagation()}
                                            onBlur={() => commitRename(entry)}
                                            onKeyDown={(ev) => {
                                                if (ev.key === 'Enter') commitRename(entry);
                                                else if (ev.key === 'Escape') setRenamingId(null);
                                            }}
                                            className="min-w-0 flex-1 rounded border border-indigo-300 bg-white px-1 py-0.5 text-xs text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-indigo-500/50 dark:bg-zinc-950 dark:text-zinc-100"
                                        />
                                    ) : (
                                        <span className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
                                            {libraryLabel(entry)}
                                        </span>
                                    )}
                                    {target.kind === 'wrapper' ? (
                                        <KindChip kind={target.savedKind} />
                                    ) : target.kind === 'inline-multi' ? (
                                        <MultiChip />
                                    ) : (
                                        <LeafChip type={target.leafType} />
                                    )}
                                </div>
                                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                                    drops as {dropsLabel}
                                </div>
                            </div>
                        );
                    })}
                </>
            )}

            <p className="mt-auto text-[10px] leading-tight text-zinc-500 dark:text-zinc-500">
                {footerHint}
            </p>

            {menu && (
                <>
                    {/* Transparent backdrop: an outside click closes the menu. */}
                    <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
                    <div
                        className="fixed z-50 min-w-[8rem] overflow-hidden rounded-md border border-zinc-200 bg-white py-1 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
                        style={{ left: menu.x, top: menu.y }}
                    >
                        <button
                            type="button"
                            onClick={() => startRename(menu.entry)}
                            className="block w-full px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                            Rename
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setConfirmDelete(menu.entry);
                                setMenu(null);
                            }}
                            className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                        >
                            Delete
                        </button>
                    </div>
                </>
            )}

            {confirmDelete && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
                    onClick={() => setConfirmDelete(null)}
                >
                    <div
                        className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
                        onClick={(ev) => ev.stopPropagation()}
                    >
                        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            Delete “{libraryLabel(confirmDelete)}”?
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                            Removes the saved template and its frozen sub-templates. Copies already
                            dropped on canvases are unaffected.
                        </p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setConfirmDelete(null)}
                                className="rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => performDelete(confirmDelete)}
                                className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </aside>
    );
}

function libraryLabel(entry: GraphSummary): string {
    const name = entry.graph.name?.trim();
    if (name && name.length > 0) return name;
    return entry.id.slice(0, 8);
}

function wrapperLabelFor(kind: SavedRefKind): string {
    switch (kind) {
        case 'toolpack':
            return 'Tool Pack';
        case 'skillpack':
            return 'Skill Pack';
        case 'handler':
            return 'Handler';
        case 'l1':
            return 'Native Agent';
    }
}

function MultiChip() {
    return (
        <span className="rounded bg-emerald-100 px-1 text-[10px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200">
            preset
        </span>
    );
}

function LeafChip({ type }: { type: Node['type'] }) {
    return (
        <span className="rounded bg-zinc-200 px-1 text-[10px] font-medium uppercase tracking-wider text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-200">
            {type}
        </span>
    );
}

function KindChip({ kind }: { kind: SavedRefKind }) {
    const cls =
        kind === 'toolpack'
            ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/20 dark:text-yellow-200'
            : kind === 'skillpack'
              ? 'bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200'
              : kind === 'handler'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'
                : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200';
    return (
        <span className={`rounded px-1 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
            {kind}
        </span>
    );
}

export { DRAG_MIME, LIBRARY_DRAG_MIME };
