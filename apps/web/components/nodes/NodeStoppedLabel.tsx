'use client';

export function NodeStoppedLabel({ reason }: { reason: string | undefined }) {
    if (!reason) return null;
    return (
        <div
            className="fab-stopped-label mt-0.5 flex items-center gap-1 truncate text-[10px] text-rose-600/90 dark:text-rose-300/90"
            title={reason}
        >
            <span aria-hidden>⏹</span>
            <span className="truncate">stopped: {reason}</span>
        </div>
    );
}
