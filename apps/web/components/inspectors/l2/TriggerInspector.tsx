import { useState } from 'react';
import type { Node, ScheduleRecurrence, TriggerNode } from '@fabritorio/types';
import type { RunnerClient } from '@/lib/runner-client';
import { Label, Input, TextArea, HeaderRow } from '../shared';

/** A manual trigger can fire by hand only when it is not paused. */
export function canFireTrigger(node: Pick<TriggerNode, 'trigger_kind' | 'paused'>): boolean {
    return node.trigger_kind === 'manual' && node.paused !== true;
}

function isoToLocalInput(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string {
    if (!local) return '';
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
}

function defaultAtIso(): string {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

const SCHEDULE_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
    { label: '5m', value: 'PT5M' },
    { label: '15m', value: 'PT15M' },
    { label: '30m', value: 'PT30M' },
    { label: '1h', value: 'PT1H' },
    { label: '2h', value: 'PT2H' },
    { label: '6h', value: 'PT6H' },
    { label: '12h', value: 'PT12H' },
];

const WEEKDAY_CHIPS: ReadonlyArray<{ label: string; value: number }> = [
    { label: 'S', value: 0 },
    { label: 'M', value: 1 },
    { label: 'T', value: 2 },
    { label: 'W', value: 3 },
    { label: 'T', value: 4 },
    { label: 'F', value: 5 },
    { label: 'S', value: 6 },
];

export function TriggerInspector({
    node,
    onChange,
    onOpenRuns,
    client,
    currentGraphId,
}: {
    node: TriggerNode;
    onChange: (id: string, patch: Partial<Node>) => void;
    onOpenRuns?: (nodeId: string) => void;
    client?: RunnerClient;
    currentGraphId?: string | null;
}) {
    const [firing, setFiring] = useState(false);
    const [firedEventId, setFiredEventId] = useState<string | null>(null);
    const [fireError, setFireError] = useState<string | null>(null);

    const canFire = canFireTrigger(node);

    const onFire = async () => {
        if (!client || !currentGraphId) return;
        setFiring(true);
        setFiredEventId(null);
        setFireError(null);
        try {
            const res = await client.fireTrigger(currentGraphId, node.id, {
                message: node.instructions,
            });
            setFiredEventId(res.eventId);
        } catch (err) {
            setFireError(err instanceof Error ? err.message : String(err));
        } finally {
            setFiring(false);
        }
    };

    return (
        <div className="space-y-3">
            <HeaderRow label="Trigger" id={node.id} />
            <label className="flex items-center gap-2 text-xs text-zinc-800 dark:text-zinc-200">
                <input
                    type="checkbox"
                    checked={node.paused === true}
                    onChange={(e) =>
                        onChange(node.id, {
                            paused: e.target.checked ? true : undefined,
                        } as Partial<Node>)
                    }
                />
                Paused
            </label>
            {onOpenRuns && (
                <button
                    type="button"
                    onClick={() => onOpenRuns(node.id)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                    View runs
                </button>
            )}
            <div>
                <Label>Kind</Label>
                <select
                    value={node.trigger_kind}
                    onChange={(e) =>
                        onChange(node.id, {
                            trigger_kind: e.target.value as TriggerNode['trigger_kind'],
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="cron">cron</option>
                    <option value="schedule">schedule</option>
                    <option value="manual">manual</option>
                </select>
            </div>
            {node.trigger_kind === 'cron' && (
                <div>
                    <Label>Expression</Label>
                    <Input
                        value={node.expression ?? ''}
                        placeholder="*/5 * * * *"
                        onChange={(e) =>
                            onChange(node.id, {
                                expression: e.target.value,
                            } as Partial<Node>)
                        }
                    />
                </div>
            )}
            {node.trigger_kind === 'schedule' && (
                <ScheduleInspector node={node} onChange={onChange} />
            )}
            <div>
                <Label>Instructions</Label>
                <TextArea
                    rows={5}
                    value={node.instructions ?? ''}
                    placeholder={
                        node.trigger_kind === 'cron'
                            ? 'Static prompt sent to the wired agent each tick'
                            : 'Long-form prompt sent to the wired agent on each fire'
                    }
                    onChange={(e) =>
                        onChange(node.id, {
                            instructions: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Instructions are the per-fire user message sent to the wired agent.
            </p>
            {node.trigger_kind === 'manual' && (
                <div className="space-y-1">
                    <button
                        type="button"
                        disabled={!canFire || firing || !client || !currentGraphId}
                        onClick={() => void onFire()}
                        className="w-full rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {firing ? 'Firing…' : 'Fire'}
                    </button>
                    {firedEventId && (
                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                            Fired · {firedEventId}
                        </p>
                    )}
                    {fireError && (
                        <p className="text-[10px] text-rose-600 dark:text-rose-400">{fireError}</p>
                    )}
                </div>
            )}
        </div>
    );
}

function ScheduleInspector({
    node,
    onChange,
}: {
    node: TriggerNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    const mode: 'once' | 'recurring' = node.at ? 'once' : 'recurring';
    const rec = node.recurrence;
    const cadence: ScheduleRecurrence['kind'] = rec?.kind ?? 'interval';
    const everyValue = rec?.kind === 'interval' ? rec.every : '';
    const presetMatch = SCHEDULE_PRESETS.find((p) => p.value === everyValue);
    const [customOpen, setCustomOpen] = useState<boolean>(Boolean(everyValue) && !presetMatch);
    const [windowOpen, setWindowOpen] = useState<boolean>(Boolean(node.from || node.until));

    const setRecurrence = (next: ScheduleRecurrence) => {
        onChange(node.id, { at: undefined, recurrence: next } as Partial<Node>);
    };

    const setMode = (next: 'once' | 'recurring') => {
        if (next === mode) return;
        if (next === 'once') {
            onChange(node.id, {
                at: defaultAtIso(),
                recurrence: undefined,
                from: undefined,
                until: undefined,
            } as Partial<Node>);
            setCustomOpen(false);
            setWindowOpen(false);
        } else {
            setRecurrence({ kind: 'interval', every: 'PT15M' });
            setCustomOpen(false);
        }
    };

    const setCadence = (next: ScheduleRecurrence['kind']) => {
        if (next === cadence) return;
        if (next === 'interval') {
            setRecurrence({ kind: 'interval', every: 'PT15M' });
            setCustomOpen(false);
        } else if (next === 'daily') {
            setRecurrence({ kind: 'daily', time: '09:00' });
        } else {
            setRecurrence({ kind: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5] });
        }
    };

    return (
        <div className="space-y-3">
            <div>
                <Label>Mode</Label>
                <div className="flex gap-2 text-xs text-zinc-800 dark:text-zinc-200">
                    <label className="flex items-center gap-1">
                        <input
                            type="radio"
                            name={`schedule-mode-${node.id}`}
                            checked={mode === 'once'}
                            onChange={() => setMode('once')}
                        />
                        Once
                    </label>
                    <label className="flex items-center gap-1">
                        <input
                            type="radio"
                            name={`schedule-mode-${node.id}`}
                            checked={mode === 'recurring'}
                            onChange={() => setMode('recurring')}
                        />
                        Recurring
                    </label>
                </div>
            </div>
            {mode === 'once' ? (
                <div>
                    <Label>Fire at</Label>
                    <Input
                        type="datetime-local"
                        value={isoToLocalInput(node.at ?? '')}
                        onChange={(e) =>
                            onChange(node.id, {
                                at: localInputToIso(e.target.value) || undefined,
                            } as Partial<Node>)
                        }
                    />
                </div>
            ) : (
                <>
                    <div>
                        <Label>Cadence</Label>
                        <div className="flex gap-1">
                            {(['interval', 'daily', 'weekly'] as const).map((c) => (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => setCadence(c)}
                                    className={
                                        cadence === c
                                            ? 'rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-medium capitalize text-white hover:bg-indigo-500'
                                            : 'rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[10px] capitalize text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
                                    }
                                >
                                    {c}
                                </button>
                            ))}
                        </div>
                    </div>
                    {cadence === 'interval' && (
                        <div>
                            <Label>Every</Label>
                            <div className="flex flex-wrap gap-1">
                                {SCHEDULE_PRESETS.map((preset) => {
                                    const active = everyValue === preset.value;
                                    return (
                                        <button
                                            key={preset.value}
                                            type="button"
                                            onClick={() => {
                                                setRecurrence({
                                                    kind: 'interval',
                                                    every: preset.value,
                                                });
                                                setCustomOpen(false);
                                            }}
                                            className={
                                                active
                                                    ? 'rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500'
                                                    : 'rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
                                            }
                                        >
                                            {preset.label}
                                        </button>
                                    );
                                })}
                                <button
                                    type="button"
                                    onClick={() => setCustomOpen(true)}
                                    className={
                                        customOpen || (everyValue && !presetMatch)
                                            ? 'rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500'
                                            : 'rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
                                    }
                                >
                                    Custom
                                </button>
                            </div>
                            {(customOpen || (everyValue && !presetMatch)) && (
                                <div className="mt-1">
                                    <Input
                                        value={everyValue}
                                        placeholder="PT7M"
                                        onChange={(e) =>
                                            setRecurrence({
                                                kind: 'interval',
                                                every: e.target.value,
                                            })
                                        }
                                    />
                                </div>
                            )}
                        </div>
                    )}
                    {cadence === 'daily' && (
                        <div>
                            <Label>Time</Label>
                            <Input
                                type="time"
                                value={rec?.kind === 'daily' ? rec.time : ''}
                                onChange={(e) =>
                                    setRecurrence({ kind: 'daily', time: e.target.value })
                                }
                            />
                        </div>
                    )}
                    {cadence === 'weekly' && (
                        <>
                            <div>
                                <Label>Days</Label>
                                <div className="flex gap-1">
                                    {WEEKDAY_CHIPS.map((chip, i) => {
                                        const days = rec?.kind === 'weekly' ? rec.days : [];
                                        const active = days.includes(chip.value);
                                        return (
                                            <button
                                                key={i}
                                                type="button"
                                                onClick={() => {
                                                    const time =
                                                        rec?.kind === 'weekly' ? rec.time : '09:00';
                                                    const next = active
                                                        ? days.filter((d) => d !== chip.value)
                                                        : [...days, chip.value].sort(
                                                              (a, b) => a - b,
                                                          );
                                                    setRecurrence({
                                                        kind: 'weekly',
                                                        time,
                                                        days: next,
                                                    });
                                                }}
                                                className={
                                                    active
                                                        ? 'h-6 w-6 rounded-md bg-indigo-600 text-[10px] font-medium text-white hover:bg-indigo-500'
                                                        : 'h-6 w-6 rounded-md border border-zinc-300 bg-white text-[10px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
                                                }
                                            >
                                                {chip.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            <div>
                                <Label>Time</Label>
                                <Input
                                    type="time"
                                    value={rec?.kind === 'weekly' ? rec.time : ''}
                                    onChange={(e) => {
                                        const days = rec?.kind === 'weekly' ? rec.days : [];
                                        setRecurrence({
                                            kind: 'weekly',
                                            time: e.target.value,
                                            days,
                                        });
                                    }}
                                />
                            </div>
                        </>
                    )}
                    <div>
                        <label className="flex items-center gap-1 text-xs text-zinc-800 dark:text-zinc-200">
                            <input
                                type="checkbox"
                                checked={windowOpen}
                                onChange={(e) => {
                                    const next = e.target.checked;
                                    setWindowOpen(next);
                                    if (!next) {
                                        onChange(node.id, {
                                            from: undefined,
                                            until: undefined,
                                        } as Partial<Node>);
                                    }
                                }}
                            />
                            Window
                        </label>
                        {windowOpen && (
                            <div className="mt-1 space-y-2">
                                <div>
                                    <Label>From</Label>
                                    <Input
                                        type="datetime-local"
                                        value={isoToLocalInput(node.from ?? '')}
                                        onChange={(e) =>
                                            onChange(node.id, {
                                                from: localInputToIso(e.target.value) || undefined,
                                            } as Partial<Node>)
                                        }
                                    />
                                </div>
                                <div>
                                    <Label>Until</Label>
                                    <Input
                                        type="datetime-local"
                                        value={isoToLocalInput(node.until ?? '')}
                                        onChange={(e) =>
                                            onChange(node.id, {
                                                until: localInputToIso(e.target.value) || undefined,
                                            } as Partial<Node>)
                                        }
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
