import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DebugProbeNode, Node } from '@fabritorio/types';
import type { DebugProbeHaltEvent, DebugProbeState, RunnerClient } from '@/lib/runner-client';
import { HeaderRow, Label, Input } from '../shared';

export function DebugProbeInspector({
    node,
    allNodes,
    onChange,
    client,
    currentGraphId,
}: {
    node: DebugProbeNode;
    allNodes: ReadonlyArray<Node>;
    onChange: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
    currentGraphId: string | null;
}) {
    const enabled = node.enabled !== false;
    const haltOn = node.haltOn ?? 'both';
    const attachOptions = useMemo(
        () =>
            allNodes
                .filter((n) => n.id !== node.id && n.type !== 'debug_probe')
                .map((n) => ({ id: n.id, type: n.type })),
        [allNodes, node.id],
    );

    const [pending, setPending] = useState<DebugProbeHaltEvent | null>(null);
    const [stateError, setStateError] = useState<string | null>(null);

    useEffect(() => {
        if (!client || !currentGraphId) {
            setPending(null);
            return;
        }
        let cancelled = false;
        void client
            .debugProbeState(currentGraphId, node.id)
            .then((s: DebugProbeState | null) => {
                if (cancelled) return;
                setPending(s?.pending ?? null);
                setStateError(null);
            })
            .catch((err) => {
                if (!cancelled) {
                    setStateError(err instanceof Error ? err.message : String(err));
                }
            });
        const stream = client.debugProbeStream(currentGraphId, node.id, (ev) => {
            setPending(ev);
        });
        return () => {
            cancelled = true;
            stream.close();
        };
    }, [client, currentGraphId, node.id]);

    const onResume = useCallback(async () => {
        if (!client || !currentGraphId) return;
        try {
            await client.debugProbeResume(currentGraphId, node.id);
            setPending(null);
        } catch (err) {
            setStateError(err instanceof Error ? err.message : String(err));
        }
    }, [client, currentGraphId, node.id]);

    return (
        <div className="space-y-3">
            <HeaderRow label="Debug Probe" id={node.id} />
            <div>
                <Label>Display name</Label>
                <Input
                    value={node.display_name ?? ''}
                    placeholder="e.g. inspect agent"
                    onChange={(e) =>
                        onChange(node.id, {
                            display_name: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Attached to</Label>
                <select
                    value={node.attachedTo ?? ''}
                    onChange={(e) =>
                        onChange(node.id, {
                            attachedTo: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="">(none — pick a target)</option>
                    {attachOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                            {opt.id} ({opt.type})
                        </option>
                    ))}
                </select>
            </div>
            <div>
                <Label>Halt phase</Label>
                <div className="flex flex-wrap gap-3 text-xs text-zinc-800 dark:text-zinc-200">
                    {(['pre', 'post', 'both'] as const).map((phase) => (
                        <label key={phase} className="flex items-center gap-1">
                            <input
                                type="radio"
                                name={`halt-${node.id}`}
                                checked={haltOn === phase}
                                onChange={() =>
                                    onChange(node.id, { haltOn: phase } as Partial<Node>)
                                }
                            />
                            {phase}
                        </label>
                    ))}
                </div>
            </div>
            <div>
                <label className="flex items-center gap-2 text-xs text-zinc-800 dark:text-zinc-200">
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) =>
                            onChange(node.id, {
                                enabled: e.target.checked,
                            } as Partial<Node>)
                        }
                    />
                    <span>Probe enabled</span>
                </label>
            </div>
            {pending && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                    <div className="font-medium">
                        Halted at {pending.observabilityType} ({pending.phase})
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] opacity-70">
                        event {pending.eventId.slice(0, 8)}…
                    </div>
                    <button
                        type="button"
                        onClick={() => void onResume()}
                        className="mt-2 rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-500"
                    >
                        Resume
                    </button>
                </div>
            )}
            {stateError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-200">
                    {stateError}
                </div>
            )}
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Taps the attached node and halts per-edge delivery so you can inspect mid-Dispatch
                state. Resume to continue. v0 covers L1/L2 boundary halts; mid-primitive halts
                inside a Handler L0 land in a follow-up.
            </p>
        </div>
    );
}
