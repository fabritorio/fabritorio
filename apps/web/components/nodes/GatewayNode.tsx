'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GatewayNode as GatewayNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { GATEWAY_PORTS } from '@/lib/ports';

type GatewayNodeProps = NodeProps & {
    data: Partial<GatewayNodeData> & { __state?: NodeExecState };
};

export function GatewayNode({ data }: GatewayNodeProps) {
    const state = data.__state ?? 'idle';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('gateway', state)}`}>
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-emerald-700 dark:text-emerald-300">
                    Gateway
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-emerald-950 dark:text-white">
                    {data.id ?? ''}
                </div>
            </div>
            <div className="fab-node-footer text-xs text-emerald-700 dark:text-emerald-200">
                sole entrance · receives Dispatch
            </div>
            <Handle id={GATEWAY_PORTS.gatewayOut.id} type="source" position={Position.Right} />
        </div>
    );
}
