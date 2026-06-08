'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelRouterNode as ModelRouterNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { NodePhaseLabel } from './NodePhaseLabel';
import { NodeStoppedLabel } from './NodeStoppedLabel';

type ModelRouterNodeProps = NodeProps & {
    data: Partial<ModelRouterNodeData> & {
        __state?: NodeExecState;
        __phaseLabel?: string;
        __stoppedReason?: string;
    };
};

export function ModelRouterNode({ data }: ModelRouterNodeProps) {
    const state = data.__state ?? 'idle';
    const policy = data.policy ?? 'failover';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('model_router', state)}`}>
            <Handle type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-indigo-700 dark:text-indigo-300">
                    Model Router
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-indigo-950 dark:text-white flex items-center gap-1.5">
                    <span aria-hidden className="text-indigo-500 dark:text-indigo-300">
                        ↻
                    </span>
                    <span>Router</span>
                </div>
                <div className="text-xs text-indigo-700/70 dark:text-indigo-200/70">
                    policy: {policy}
                </div>
                <NodePhaseLabel label={data.__phaseLabel} />
                <NodeStoppedLabel reason={data.__stoppedReason} />
            </div>
            <Handle type="source" position={Position.Right} />
        </div>
    );
}
