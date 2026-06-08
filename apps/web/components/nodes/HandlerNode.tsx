'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { HandlerNode as HandlerNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { NodePhaseLabel } from './NodePhaseLabel';
import { NodeStoppedLabel } from './NodeStoppedLabel';
import { NodeIterPips } from './NodeIterPips';

type Props = NodeProps & {
    data: Partial<HandlerNodeData> & {
        __state?: NodeExecState;
        __phaseLabel?: string;
        __iter?: { n: number; max?: number };
        __stoppedReason?: string;
    };
};

export function HandlerNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const cap = data.max_iterations;
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('handler', state)}`}>
            <Handle type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-slate-700 dark:text-slate-300">
                    Handler
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-slate-950 dark:text-white">
                    {data.name ?? '(unnamed)'}
                </div>
                <NodePhaseLabel label={data.__phaseLabel} />
                <NodeIterPips iter={data.__iter} />
                <NodeStoppedLabel reason={data.__stoppedReason} />
            </div>
            <div className="fab-node-footer text-xs text-slate-600 dark:text-slate-200">
                {cap ? `loop · max ${cap}` : 'default ReAct'}
            </div>
            <Handle type="source" position={Position.Right} />
        </div>
    );
}
