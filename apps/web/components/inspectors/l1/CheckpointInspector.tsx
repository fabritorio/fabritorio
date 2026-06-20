import type { CheckpointCadence, CheckpointNode, Node } from '@fabritorio/types';
import { GHOST_PREFIX } from '@/lib/ghost';
import { HeaderRow, Label, Input, IntListInput, parseOptionalNumber } from '../shared';

const STRATEGY_AGENT_TYPES: ReadonlySet<Node['type']> = new Set<Node['type']>(['native_agent']);

function agentLabel(node: Node): string {
    const named =
        'display_name' in node &&
        typeof node.display_name === 'string' &&
        node.display_name.length > 0
            ? node.display_name
            : null;
    return named ?? node.id;
}

export function CheckpointInspector({
    node,
    ghostNodes,
    onChange,
    onSelectNode,
}: {
    node: CheckpointNode;
    ghostNodes: ReadonlyArray<Node>;
    onChange: (id: string, patch: Partial<Node>) => void;
    onSelectNode?: (id: string) => void;
}) {
    const reachableAgents = ghostNodes.filter((n) => STRATEGY_AGENT_TYPES.has(n.type));
    const selectedIsReachable = node.agent_id
        ? reachableAgents.some((n) => n.id === node.agent_id)
        : true;

    const cadence = node.cadence;
    const setCadence = (next: CheckpointCadence) => {
        onChange(node.id, { cadence: next } as Partial<Node>);
    };
    const onKindChange = (kind: CheckpointCadence['kind']) => {
        if (kind === cadence.kind) return;
        setCadence(
            kind === 'iterations'
                ? { kind: 'iterations', at: [] }
                : { kind: 'tokens', at_fraction: 0.8 },
        );
    };

    return (
        <div className="space-y-3">
            <HeaderRow label="Checkpoint" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Pauses the handler loop at the cadence and consults a strategy agent. Wire{' '}
                <code>checkpoint → handler</code>; the consulted agent is a ghost ref reachable from
                the parent agent&apos;s L2.
            </p>
            <div>
                <Label>Strategy</Label>
                <select
                    value={node.strategy}
                    onChange={(e) =>
                        onChange(node.id, {
                            strategy: e.target.value as CheckpointNode['strategy'],
                        } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="supervisor">supervisor (continue / stop verdict)</option>
                    <option value="mutator">mutator (compaction summary)</option>
                </select>
            </div>
            <div>
                <Label>Cadence</Label>
                <select
                    value={cadence.kind}
                    onChange={(e) => onKindChange(e.target.value as CheckpointCadence['kind'])}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="iterations">iterations (fire at breakpoints)</option>
                    <option value="tokens">tokens (fire past a budget fraction)</option>
                </select>
            </div>
            {cadence.kind === 'iterations' ? (
                <div>
                    <Label>Breakpoints (iterations)</Label>
                    <IntListInput
                        key={node.id}
                        value={cadence.at}
                        placeholder="10, 50, 100"
                        onCommit={(at) => setCadence({ kind: 'iterations', at })}
                    />
                    <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-600">
                        Comma-separated iteration counts at which to consult.
                    </p>
                </div>
            ) : (
                <div>
                    <Label>Budget fraction</Label>
                    <Input
                        type="number"
                        min={0}
                        max={1}
                        step="0.05"
                        value={cadence.at_fraction}
                        placeholder="0.8"
                        onChange={(e) => {
                            const f = parseOptionalNumber(e.target.value);
                            setCadence({ kind: 'tokens', at_fraction: f ?? 0 });
                        }}
                    />
                    <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-600">
                        Consult once the buffer passes this fraction of the context window.
                    </p>
                </div>
            )}
            <div>
                <Label>Strategy agent</Label>
                <select
                    value={node.agent_id}
                    onChange={(e) =>
                        onChange(node.id, { agent_id: e.target.value } as Partial<Node>)
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="">— pick a reachable agent —</option>
                    {reachableAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                            {agentLabel(a)}
                        </option>
                    ))}
                    {node.agent_id && !selectedIsReachable && (
                        <option value={node.agent_id}>{node.agent_id} (not reachable)</option>
                    )}
                </select>
                {node.agent_id && onSelectNode && (
                    <button
                        type="button"
                        onClick={() => onSelectNode(`${GHOST_PREFIX}${node.agent_id}`)}
                        className="mt-1 text-[10px] text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                        View agent
                    </button>
                )}
                <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-600">
                    Only agents wired to the parent NativeAgent at L2 are reachable (same gate as{' '}
                    <code>ask_agent</code>). Wire the consulted agent there first if it&apos;s
                    missing.
                </p>
            </div>
            <div>
                <Label>Window (optional)</Label>
                <Input
                    type="number"
                    min={1}
                    value={node.window ?? ''}
                    placeholder="whole buffer"
                    onChange={(e) =>
                        onChange(node.id, {
                            window: parseOptionalNumber(e.target.value),
                        } as Partial<Node>)
                    }
                />
                <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-600">
                    Recent messages sent to the strategy model. Default: the whole buffer.
                </p>
            </div>
            {node.strategy === 'mutator' && (
                <div>
                    <Label>Keep last (optional)</Label>
                    <Input
                        type="number"
                        min={0}
                        value={node.keep_last ?? ''}
                        placeholder="4"
                        onChange={(e) =>
                            onChange(node.id, {
                                keep_last: parseOptionalNumber(e.target.value),
                            } as Partial<Node>)
                        }
                    />
                    <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-600">
                        Recent turns the evaluator keeps verbatim when it splices in the summary.
                    </p>
                </div>
            )}
        </div>
    );
}
