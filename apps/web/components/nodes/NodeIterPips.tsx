'use client';

export function NodeIterPips({ iter }: { iter: { n: number; max?: number } | undefined }) {
    if (!iter || iter.n <= 0) return null;
    const { n, max } = iter;
    const label = max !== undefined ? `iter ${n}/${max}` : `iter ${n}`;
    const dots = max !== undefined ? Math.min(max, 12) : Math.min(n, 12);
    return (
        <div
            className="fab-iter-pips mt-0.5 flex items-center gap-1 text-[10px] text-slate-600 dark:text-slate-300"
            title={label}
        >
            <span className="font-mono tabular-nums">{label}</span>
            {dots > 0 ? (
                <span className="flex items-center gap-[2px]" aria-hidden>
                    {Array.from({ length: dots }).map((_, i) => (
                        <span
                            key={i}
                            className={`inline-block h-1 w-1 rounded-full ${
                                i < n
                                    ? 'bg-indigo-500 dark:bg-indigo-400'
                                    : 'bg-slate-300 dark:bg-slate-600'
                            }`}
                        />
                    ))}
                </span>
            ) : null}
        </div>
    );
}
