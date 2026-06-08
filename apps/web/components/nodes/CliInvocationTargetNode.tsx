'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CliInvocationTargetNode as CliInvocationTargetNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';

type Props = NodeProps & {
    data: Partial<CliInvocationTargetNodeData> & { __state?: NodeExecState };
};

export function CliInvocationTargetNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const display =
        data.display_name && data.display_name.length > 0 ? data.display_name : 'CLI Agent';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('cli_invocation_target', state)}`}>
            <Handle type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-blue-700 dark:text-blue-300">
                    Agent Target
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-blue-950 dark:text-white">{display}</div>
            </div>
            <div className="fab-node-footer text-xs text-blue-700 dark:text-blue-200">
                wire Model / Workspace / Skills into me
            </div>
            <Handle type="source" position={Position.Right} />
        </div>
    );
}
