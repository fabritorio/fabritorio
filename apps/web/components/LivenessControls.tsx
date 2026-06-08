import type { GraphLiveness } from '@/lib/runner-client';

export function LivenessBadge({ liveness }: { liveness: GraphLiveness }) {
    const cls =
        liveness === 'running'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'
            : liveness === 'stopped'
              ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200'
              : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700/50 dark:text-zinc-300';
    return (
        <span className={`rounded px-1 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
            {liveness}
        </span>
    );
}

export function LivenessToggle({
    liveness,
    name,
    onStop,
    onResume,
}: {
    liveness: GraphLiveness;
    name: string;
    onStop: () => void | Promise<void>;
    onResume: () => void | Promise<void>;
}) {
    if (liveness === 'stopped') {
        return (
            <button
                type="button"
                onClick={() => void onResume()}
                title="Resume this graph (clears the stop)"
                className="rounded p-1 text-zinc-400 hover:bg-emerald-100 hover:text-emerald-700 dark:hover:bg-emerald-950/60 dark:hover:text-emerald-300"
                aria-label={`Resume ${name}`}
            >
                ▶
            </button>
        );
    }
    return (
        <button
            type="button"
            onClick={() => void onStop()}
            title="Stop this graph (unloads + pauses autonomous triggers)"
            className="rounded p-1 text-zinc-400 hover:bg-amber-100 hover:text-amber-700 dark:hover:bg-amber-950/60 dark:hover:text-amber-300"
            aria-label={`Stop ${name}`}
        >
            ■
        </button>
    );
}
