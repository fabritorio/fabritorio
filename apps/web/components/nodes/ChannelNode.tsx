'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ChannelNode as ChannelNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { CHANNEL_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<ChannelNodeData> & { __state?: NodeExecState };
};

export function ChannelNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const kind = data.channel_kind ?? 'webchat';
    const display = data.display_name && data.display_name.length > 0 ? data.display_name : kind;
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('channel', state)}`}>
            <Handle id={CHANNEL_PORTS.in.id} type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-emerald-700 dark:text-emerald-300">
                    Channel
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {kind}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-emerald-950 dark:text-white">
                    {display}
                </div>
            </div>
            <div className="fab-node-footer text-xs text-emerald-700 dark:text-emerald-200">
                external interface · publish + reply
            </div>
            <Handle id={CHANNEL_PORTS.out.id} type="source" position={Position.Right} />
        </div>
    );
}
