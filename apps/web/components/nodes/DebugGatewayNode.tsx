'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { DebugGatewayNode as DebugGatewayNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { DEBUG_GATEWAY_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<DebugGatewayNodeData> & { __state?: NodeExecState };
};

export function DebugGatewayNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const mode = data.mode ?? 'live';
    const display =
        data.display_name && data.display_name.length > 0 ? data.display_name : 'Debug session';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('debug_gateway', state)}`}>
            <Handle id={DEBUG_GATEWAY_PORTS.in.id} type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-fuchsia-700 dark:text-fuchsia-300">
                    Debug Gateway
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {mode}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-fuchsia-950 dark:text-white">
                    {display}
                </div>
            </div>
            <div className="fab-node-footer text-xs text-fuchsia-700 dark:text-fuchsia-200">
                ephemeral substitute · drive from inspector
            </div>
            <Handle id={DEBUG_GATEWAY_PORTS.out.id} type="source" position={Position.Right} />
        </div>
    );
}
