'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PermissionNode as PermissionNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { PERMISSION_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<PermissionNodeData> & { __state?: NodeExecState };
};

export function PermissionNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const strategy = data.strategy ?? 'call_user';
    const label = data.label ?? humanizeStrategy(strategy);
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('permission', state)}`}>
            <Handle id={PERMISSION_PORTS.toolsIn.id} type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-red-700 dark:text-red-300">
                    Permission
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-mono font-medium text-slate-950 dark:text-white">
                    {label}
                </div>
            </div>
            <Handle id={PERMISSION_PORTS.toolsOut.id} type="source" position={Position.Right} />
        </div>
    );
}

function humanizeStrategy(strategy: PermissionNodeData['strategy']): string {
    switch (strategy) {
        case 'call_user':
            return 'ask user';
        default:
            return strategy ?? 'ask user';
    }
}
