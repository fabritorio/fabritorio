'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ActiveAsk, NativeAgentNode as NativeAgentNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { AskingChip } from './AskingChip';
import { NodePhaseLabel } from './NodePhaseLabel';
import { NodeStoppedLabel } from './NodeStoppedLabel';
import { NodeIterPips } from './NodeIterPips';

type Props = NodeProps & {
    data: Partial<NativeAgentNodeData> & {
        __state?: NodeExecState;
        __activeAsks?: ReadonlyArray<ActiveAsk>;
        __askTargetNames?: ReadonlyMap<string, string>;
        __phaseLabel?: string;
        __iter?: { n: number; max?: number };
        __stoppedReason?: string;
    };
};

export function NativeAgentNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const display =
        data.display_name && data.display_name.length > 0 ? data.display_name : 'Native Agent';
    const ref =
        data.l1_graph_id && data.l1_graph_id.length > 0
            ? `→ ${data.l1_graph_id.slice(0, 8)}`
            : '(no L1 graph)';
    const activeAsks = data.__activeAsks ?? [];
    const askTargetNames = data.__askTargetNames ?? EMPTY_NAMES;
    return (
        <div className="relative">
            <AskingChip activeAsks={activeAsks} targetNames={askTargetNames} />
            <div className={`min-w-[220px] ${nodeStateClassName('native_agent', state)}`}>
                <Handle type="target" position={Position.Left} />
                <div className="fab-node-header">
                    <span className="text-[10px] uppercase tracking-wider font-medium text-sky-700 dark:text-sky-300">
                        Native Agent
                    </span>
                    <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                        {state}
                    </span>
                </div>
                <div className="fab-node-body">
                    <div className="text-sm font-medium text-sky-950 dark:text-white">
                        {display}
                    </div>
                    <div className="text-xs font-mono text-sky-700/70 dark:text-sky-200/70">
                        {ref}
                    </div>
                    <NodePhaseLabel label={data.__phaseLabel} />
                    <NodeIterPips iter={data.__iter} />
                    <NodeStoppedLabel reason={data.__stoppedReason} />
                </div>
                <div className="fab-node-footer text-[10px] text-sky-700 dark:text-sky-200">
                    double-click to drill in
                </div>
                <Handle type="source" position={Position.Right} />
            </div>
        </div>
    );
}

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();
