'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ActiveAsk, PiAgentNode as PiAgentNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { AskingChip } from './AskingChip';
import { NodePhaseLabel } from './NodePhaseLabel';

type Props = NodeProps & {
    data: Partial<PiAgentNodeData> & {
        __state?: NodeExecState;
        __activeAsks?: ReadonlyArray<ActiveAsk>;
        __askTargetNames?: ReadonlyMap<string, string>;
        __phaseLabel?: string;
    };
};

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

export function PiAgentNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const display =
        data.display_name && data.display_name.length > 0 ? data.display_name : 'Pi Agent';
    const command = data.command && data.command.length > 0 ? data.command : 'pi';
    const session = data.session_mode ?? 'session-aware';
    const modelLine =
        data.provider || data.model
            ? `${data.provider ?? 'default'}${data.model ? ` · ${data.model}` : ''}`
            : null;
    const hasFooter = Boolean(data.cwd) || Boolean(data.ref_id);
    const activeAsks = data.__activeAsks ?? [];
    const askTargetNames = data.__askTargetNames ?? EMPTY_NAMES;
    return (
        <div className="relative">
            <AskingChip activeAsks={activeAsks} targetNames={askTargetNames} />
            <div className={`min-w-[220px] ${nodeStateClassName('pi_agent', state)}`}>
                <Handle type="target" position={Position.Left} />
                <div className="fab-node-header">
                    <span className="text-[10px] uppercase tracking-wider font-medium text-teal-700 dark:text-teal-300">
                        Pi Agent
                    </span>
                    <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                        {state}
                    </span>
                </div>
                <div className="fab-node-body">
                    <div className="text-sm font-medium text-teal-950 dark:text-white">
                        {display}
                    </div>
                    <div className="text-xs font-mono text-teal-700/70 dark:text-teal-200/70">
                        {command} · {session}
                    </div>
                    {modelLine && (
                        <div className="text-[10px] font-mono text-teal-700/60 dark:text-teal-200/60">
                            {modelLine}
                        </div>
                    )}
                    <NodePhaseLabel label={data.__phaseLabel} />
                </div>
                {hasFooter && (
                    <div className="fab-node-footer text-[10px] text-teal-700 dark:text-teal-200">
                        {data.cwd && <div className="font-mono">cwd: {data.cwd}</div>}
                        {data.ref_id && <div>double-click to drill in</div>}
                    </div>
                )}
                <Handle type="source" position={Position.Right} />
            </div>
        </div>
    );
}
