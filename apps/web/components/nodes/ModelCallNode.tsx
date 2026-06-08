'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelCallNode as ModelCallNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';

type Props = NodeProps & {
    data: Partial<ModelCallNodeData> & { __state?: NodeExecState };
};

export function ModelCallNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('model_call', state)}`}>
            <Handle type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-indigo-700 dark:text-indigo-300">
                    Model Call
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-indigo-950 dark:text-white">
                    {data.id ?? ''}
                </div>
            </div>
            <div className="fab-node-footer text-xs text-indigo-700 dark:text-indigo-200">
                calls wired Model with buffer
            </div>
            <Handle type="source" position={Position.Right} />
        </div>
    );
}
