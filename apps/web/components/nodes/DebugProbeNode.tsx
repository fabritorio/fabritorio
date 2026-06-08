'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { DebugProbeNode as DebugProbeNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { DEBUG_PROBE_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<DebugProbeNodeData> & { __state?: NodeExecState };
};

export function DebugProbeNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const enabled = data.enabled !== false;
    const halt = data.haltOn ?? 'both';
    const display = data.display_name && data.display_name.length > 0 ? data.display_name : 'Probe';
    const target = data.attachedTo && data.attachedTo.length > 0 ? data.attachedTo : '(none)';
    return (
        <div className={`min-w-[150px] ${nodeStateClassName('debug_probe', state)}`}>
            <div className="fab-node-header">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium text-fuchsia-700 dark:text-fuchsia-300">
                    <span
                        aria-hidden
                        className={`inline-block h-2 w-2 rounded-full ${
                            enabled
                                ? 'bg-fuchsia-500 dark:bg-fuchsia-400'
                                : 'bg-zinc-400 dark:bg-zinc-600'
                        }`}
                    />
                    Probe
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {halt}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-xs font-medium text-fuchsia-950 dark:text-white">
                    {display}
                </div>
                <div className="text-[10px] text-fuchsia-700/70 dark:text-fuchsia-200/70">
                    → <span className="font-mono">{target}</span>
                    {!enabled && ' (off)'}
                </div>
            </div>
            <Handle id={DEBUG_PROBE_PORTS.attachOut.id} type="source" position={Position.Right} />
        </div>
    );
}
