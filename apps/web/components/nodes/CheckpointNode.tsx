'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CheckpointNode as CheckpointNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { CHECKPOINT_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<CheckpointNodeData> & { __state?: NodeExecState };
};

export function CheckpointNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const strategy = data.strategy ?? 'supervisor';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('checkpoint', state)}`}>
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-amber-700 dark:text-amber-300">
                    Checkpoint
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-mono font-medium text-slate-950 dark:text-white">
                    {strategy}
                </div>
                <div className="text-xs font-mono text-amber-700/70 dark:text-amber-200/70">
                    {cadenceSummary(data.cadence)}
                </div>
                <div className="text-xs font-mono text-amber-700/70 dark:text-amber-200/70">
                    {data.agent_id && data.agent_id.length > 0
                        ? `ghost: ${data.agent_id.slice(0, 12)}`
                        : '(no agent)'}
                </div>
            </div>
            <Handle id={CHECKPOINT_PORTS.handlerOut.id} type="source" position={Position.Right} />
        </div>
    );
}

function cadenceSummary(cadence: CheckpointNodeData['cadence'] | undefined): string {
    if (!cadence) return 'no cadence';
    if (cadence.kind === 'iterations') {
        return cadence.at.length > 0 ? `iters [${cadence.at.join(', ')}]` : 'iters []';
    }
    return `tokens > ${Math.round((cadence.at_fraction ?? 0) * 100)}%`;
}
