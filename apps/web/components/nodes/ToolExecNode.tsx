'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ToolExecNode as ToolExecNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';

type Props = NodeProps & {
    data: Partial<ToolExecNodeData> & { __state?: NodeExecState };
};

export function ToolExecNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('tool_exec', state)}`}>
            <Handle type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-orange-700 dark:text-orange-300">
                    Tool Exec
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-orange-950 dark:text-white">
                    {data.id ?? ''}
                </div>
            </div>
            <div className="fab-node-footer text-xs text-orange-700 dark:text-orange-200">
                runs tool_calls against wired Tools
            </div>
            <Handle type="source" position={Position.Right} />
        </div>
    );
}
