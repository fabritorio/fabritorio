'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TriggerNode as TriggerNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { TRIGGER_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<TriggerNodeData> & { __state?: NodeExecState };
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function humanizeIsoDuration(iso: string): string {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
    if (!m || m[0] === 'P' || m[0] === 'PT') return iso;
    const parts = [
        m[1] && `${m[1]}d`,
        m[2] && `${m[2]}h`,
        m[3] && `${m[3]}m`,
        m[4] && `${m[4]}s`,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : iso;
}

function humanizeAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(d);
}

export function TriggerNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const kind = data.trigger_kind ?? 'cron';
    const sub = (() => {
        switch (kind) {
            case 'cron':
                return data.expression || '(no expression)';
            case 'schedule': {
                if (data.at) return `📅 once @ ${humanizeAt(data.at)}`;
                const rec = data.recurrence;
                if (rec) {
                    switch (rec.kind) {
                        case 'interval':
                            return `📅 every ${humanizeIsoDuration(rec.every)}`;
                        case 'daily':
                            return `📅 daily @ ${rec.time}`;
                        case 'weekly':
                            return `📅 ${rec.days.map((d) => WEEKDAY_SHORT[d] ?? d).join(',')} @ ${rec.time}`;
                    }
                }
                return '📅 schedule (unconfigured)';
            }
            case 'webhook':
                return data.path ? `${data.method ?? 'POST'} ${data.path}` : '(no path)';
            case 'event':
                return data.topic || '(no topic)';
            default:
                return 'manual fire';
        }
    })();
    const paused = data.paused === true;
    const footer = kind === 'cron' || kind === 'schedule' ? 'fires on schedule' : 'runtime pending';
    return (
        <div
            className={`min-w-[200px] ${nodeStateClassName('trigger', state)}${paused ? ' opacity-50' : ''}`}
        >
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-rose-700 dark:text-rose-300">
                    Trigger
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {kind}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-mono font-medium text-rose-950 dark:text-white">
                    {sub}
                </div>
            </div>
            <div className="fab-node-footer text-[10px] text-rose-700 dark:text-rose-200">
                {paused ? `${footer} · paused` : footer}
            </div>
            <Handle id={TRIGGER_PORTS.out.id} type="source" position={Position.Right} />
        </div>
    );
}
