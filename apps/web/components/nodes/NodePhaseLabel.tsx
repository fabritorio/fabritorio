'use client';

export function NodePhaseLabel({ label }: { label: string | undefined }) {
    if (!label) return null;
    const reasoning = label.startsWith('thinking');
    return (
        <div
            className={`fab-phase-label truncate text-[10px] ${
                reasoning
                    ? 'italic text-violet-500/80 dark:text-violet-300/70'
                    : 'text-indigo-600/80 dark:text-indigo-300/80'
            }`}
            title={label}
        >
            {label}
        </div>
    );
}
