import { useCallback, useEffect, useState } from 'react';
import type { Node, SkillNode } from '@fabritorio/types';
import type { RunnerClient, SkillDetail, SkillSummary } from '@/lib/runner-client';
import { HeaderRow, Label, Input } from '../shared';
import { MarkdownContent } from '../../MarkdownContent';

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    if (!match) return { frontmatter: '', body: raw };
    return { frontmatter: match[1] ?? '', body: raw.slice(match[0].length) };
}

function newSkillTemplate(name: string): string {
    return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\nDescribe what this skill does and when the model should use it.\n`;
}

function isValidSkillName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name.length <= 64;
}

export function SkillInspector({
    node,
    onChange,
    client,
}: {
    node: SkillNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
}) {
    const [skills, setSkills] = useState<SkillSummary[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    const reloadSkills = useCallback(async () => {
        if (!client) {
            setSkills(null);
            return;
        }
        try {
            setSkills(await client.listSkills());
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);

    useEffect(() => {
        let cancelled = false;
        if (!client) {
            setSkills(null);
            return;
        }
        void client
            .listSkills()
            .then((list) => {
                if (!cancelled) setSkills(list);
            })
            .catch((err) => {
                if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
    }, [client]);

    const knownNames = new Set(skills?.map((s) => s.name) ?? []);
    const showStaleOption = node.name.length > 0 && skills !== null && !knownNames.has(node.name);

    return (
        <div className="space-y-3">
            <HeaderRow label="Skill" id={node.id} />
            <div>
                <Label>Skill name</Label>
                {skills === null && !loadError ? (
                    <Input value={node.name} disabled placeholder="loading…" />
                ) : skills === null ? (
                    <Input
                        value={node.name}
                        placeholder="e.g. planner"
                        onChange={(e) =>
                            onChange(node.id, { name: e.target.value } as Partial<Node>)
                        }
                    />
                ) : (
                    <select
                        value={node.name}
                        onChange={(e) =>
                            onChange(node.id, { name: e.target.value } as Partial<Node>)
                        }
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    >
                        <option value="">(select a skill)</option>
                        {skills.map((s) => (
                            <option key={s.name} value={s.name}>
                                {s.name}
                            </option>
                        ))}
                        {showStaleOption && (
                            <option value={node.name}>{node.name} (not in catalog)</option>
                        )}
                    </select>
                )}
            </div>
            {loadError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    Skill catalog failed to load: {loadError}
                </div>
            )}
            {client && (
                <SkillContentEditor
                    name={node.name}
                    client={client}
                    onSkillCreated={(name) => {
                        onChange(node.id, { name } as Partial<Node>);
                        void reloadSkills();
                    }}
                    onSkillSaved={() => void reloadSkills()}
                />
            )}
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Wire this node to a Handler to grant the model permission to invoke the skill via
                the built-in Skill tool.
            </p>
        </div>
    );
}

function SkillContentEditor({
    name,
    client,
    onSkillCreated,
    onSkillSaved,
}: {
    name: string;
    client: RunnerClient;
    onSkillCreated: (name: string) => void;
    onSkillSaved: () => void;
}) {
    const [detail, setDetail] = useState<SkillDetail | null>(null);
    const [draft, setDraft] = useState('');
    const [mode, setMode] = useState<'preview' | 'edit'>('preview');
    const [status, setStatus] = useState<'idle' | 'loading' | 'missing' | 'error'>('idle');
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [createError, setCreateError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setSaveError(null);
        if (!name) {
            setDetail(null);
            setDraft('');
            setStatus('idle');
            return;
        }
        setStatus('loading');
        void client
            .getSkill(name)
            .then((d) => {
                if (cancelled) return;
                if (!d) {
                    setDetail(null);
                    setDraft('');
                    setStatus('missing');
                    return;
                }
                setDetail(d);
                setDraft(d.raw);
                setMode('preview');
                setStatus('idle');
            })
            .catch((err) => {
                if (cancelled) return;
                setLoadError(err instanceof Error ? err.message : String(err));
                setStatus('error');
            });
        return () => {
            cancelled = true;
        };
    }, [name, client]);

    const dirty = detail !== null && draft !== detail.raw;
    const preview = splitFrontmatter(draft);

    const save = async () => {
        if (!name) return;
        setSaving(true);
        setSaveError(null);
        try {
            const saved = await client.saveSkill(name, draft);
            setDetail(saved);
            setDraft(saved.raw);
            onSkillSaved();
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    const create = async () => {
        const trimmed = newName.trim();
        if (!isValidSkillName(trimmed)) {
            setCreateError('Use letters, digits, ._- and lead with an alphanumeric (max 64).');
            return;
        }
        setCreateError(null);
        try {
            await client.saveSkill(trimmed, newSkillTemplate(trimmed));
            setCreating(false);
            setNewName('');
            setMode('edit');
            onSkillCreated(trimmed);
        } catch (err) {
            setCreateError(err instanceof Error ? err.message : String(err));
        }
    };

    return (
        <div className="space-y-2">
            {name && (
                <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center justify-between gap-2 rounded-t-md border-b border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900/60">
                        <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            SKILL.md{dirty ? ' •' : ''}
                        </span>
                        <div className="flex items-center gap-1">
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
                        </div>
                    </div>
                    {status === 'loading' && (
                        <div className="px-2 py-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                            Loading SKILL.md…
                        </div>
                    )}
                    {status === 'missing' && (
                        <div className="px-2 py-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                            “{name}” isn’t on disk yet. Save below to create it, or pick another
                            skill.
                        </div>
                    )}
                    {status === 'error' && (
                        <div className="px-2 py-3 text-[11px] text-rose-700 dark:text-rose-300">
                            Failed to load: {loadError}
                        </div>
                    )}
                    {(status === 'idle' || status === 'missing') &&
                        (mode === 'preview' ? (
                            <div className="max-h-72 overflow-auto px-3 py-2">
                                {preview.body.trim().length > 0 ? (
                                    <MarkdownContent content={preview.body} />
                                ) : (
                                    <p className="text-[11px] italic text-zinc-400">(empty body)</p>
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
                        ))}
                </div>
            )}
            {saveError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    Save failed: {saveError}
                </div>
            )}
            <div className="flex items-center gap-2">
                {name && (status === 'idle' || status === 'missing') && (
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={saving || (!dirty && status === 'idle')}
                        className="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                )}
                {name && dirty && (
                    <button
                        type="button"
                        onClick={() => detail && setDraft(detail.raw)}
                        className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                    >
                        Revert
                    </button>
                )}
                {!creating && (
                    <button
                        type="button"
                        onClick={() => {
                            setCreating(true);
                            setCreateError(null);
                        }}
                        className="ml-auto text-[11px] text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                    >
                        + New skill
                    </button>
                )}
            </div>
            {creating && (
                <div className="space-y-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                    <Label>New skill name</Label>
                    <div className="flex items-center gap-2">
                        <Input
                            autoFocus
                            value={newName}
                            placeholder="e.g. planner"
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void create();
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => void create()}
                            className="shrink-0 rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
                        >
                            Create
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setCreating(false);
                                setNewName('');
                                setCreateError(null);
                            }}
                            className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                        >
                            Cancel
                        </button>
                    </div>
                    {createError && (
                        <p className="text-[10px] text-rose-700 dark:text-rose-300">
                            {createError}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
