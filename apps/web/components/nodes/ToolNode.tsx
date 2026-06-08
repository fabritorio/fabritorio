'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ToolNode as ToolNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { TOOL_PORTS } from '@/lib/ports';
import { NodePhaseLabel } from './NodePhaseLabel';
import { NodeStoppedLabel } from './NodeStoppedLabel';

type Props = NodeProps & {
    data: Partial<ToolNodeData> & {
        __state?: NodeExecState;
        __phaseLabel?: string;
        __toolArgPreview?: string;
        __toolExitOk?: boolean;
        __stoppedReason?: string;
    };
};

export function ToolNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const label =
        data.tool_name && data.tool_name.length > 0 ? data.tool_name : '(no tool selected)';
    const tap = data.__toolArgPreview;
    const exitOk = data.__toolExitOk;
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('tool', state)}`}>
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-orange-700 dark:text-orange-300">
                    Tool
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-mono font-medium text-slate-950 dark:text-white">
                    {label}
                </div>
                {tap ? (
                    <div
                        className="fab-tool-tap mt-0.5 flex items-start gap-1 font-mono text-[10px] text-orange-800/90 dark:text-orange-200/90"
                        title={tap}
                    >
                        {exitOk !== undefined ? (
                            <span
                                aria-hidden
                                className={
                                    exitOk
                                        ? 'text-emerald-600 dark:text-emerald-400'
                                        : 'text-rose-600 dark:text-rose-400'
                                }
                            >
                                {exitOk ? '✓' : '✗'}
                            </span>
                        ) : null}
                        <span className="truncate">{tap}</span>
                    </div>
                ) : null}
                <NodePhaseLabel label={data.__phaseLabel} />
                <NodeStoppedLabel reason={data.__stoppedReason} />
            </div>
            <Handle id={TOOL_PORTS.secretsIn.id} type="target" position={Position.Left} />
            <Handle id={TOOL_PORTS.toolOut.id} type="source" position={Position.Right} />
        </div>
    );
}
