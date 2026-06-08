'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelNode as ModelNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { NodePhaseLabel } from './NodePhaseLabel';
import { NodeStoppedLabel } from './NodeStoppedLabel';

type ModelNodeProps = NodeProps & {
    data: Partial<ModelNodeData> & {
        __state?: NodeExecState;
        __phaseLabel?: string;
        __routerTrying?: string;
        __fellThroughReason?: string;
        __stoppedReason?: string;
    };
};

export function ModelNode({ data }: ModelNodeProps) {
    const state = data.__state ?? 'idle';
    const trying = data.__routerTrying;
    const fellThrough = data.__fellThroughReason;
    const cascadeClass = fellThrough
        ? 'fab-router-fell-through'
        : trying
          ? 'fab-router-trying'
          : '';
    return (
        <div
            className={`min-w-[200px] ${nodeStateClassName('model', state)} ${cascadeClass}`.trim()}
        >
            <Handle type="target" position={Position.Left} />
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-indigo-700 dark:text-indigo-300">
                    Model
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-indigo-950 dark:text-white">
                    {data.model_id ?? '(no model)'}
                </div>
                <div className="text-xs text-indigo-700/70 dark:text-indigo-200/70">
                    {data.provider ?? 'provider?'}
                </div>
                {trying && !fellThrough ? (
                    <div
                        className="mt-0.5 truncate text-[10px] text-indigo-600/90 dark:text-indigo-300/90"
                        title={`trying ${trying}`}
                    >
                        ↻ trying {trying}
                    </div>
                ) : null}
                {fellThrough ? (
                    <div
                        className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-rose-600/90 dark:text-rose-300/90"
                        title={fellThrough}
                    >
                        <span aria-hidden>⤳</span>
                        <span className="truncate">fell through: {fellThrough}</span>
                    </div>
                ) : null}
                <NodePhaseLabel label={data.__phaseLabel} />
                <NodeStoppedLabel reason={data.__stoppedReason} />
            </div>
            <Handle type="source" position={Position.Right} />
        </div>
    );
}
