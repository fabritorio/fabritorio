'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ActiveAsk, CliAgentNode as CliAgentNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { AskingChip } from './AskingChip';
import { NodePhaseLabel } from './NodePhaseLabel';

type Props = NodeProps & {
    data: Partial<CliAgentNodeData> & {
        __state?: NodeExecState;
        __activeAsks?: ReadonlyArray<ActiveAsk>;
        __askTargetNames?: ReadonlyMap<string, string>;
        __phaseLabel?: string;
    };
};

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

export function CliAgentNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const display =
        data.display_name && data.display_name.length > 0 ? data.display_name : 'CLI Agent';
    const command = data.command && data.command.length > 0 ? data.command : '(no command)';
    const session = data.session_mode ?? 'session-aware';
    const activeAsks = data.__activeAsks ?? [];
    const askTargetNames = data.__askTargetNames ?? EMPTY_NAMES;
    return (
        <div className="relative">
            <AskingChip activeAsks={activeAsks} targetNames={askTargetNames} />
            <div className={`min-w-[220px] ${nodeStateClassName('cli_agent', state)}`}>
                <Handle type="target" position={Position.Left} />
                <div className="fab-node-header">
                    <span className="text-[10px] uppercase tracking-wider font-medium text-blue-700 dark:text-blue-300">
                        CLI Agent
                    </span>
                    <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                        {state}
                    </span>
                </div>
                <div className="fab-node-body">
                    <div className="text-sm font-medium text-blue-950 dark:text-white">
                        {display}
                    </div>
                    <div className="text-xs font-mono text-blue-700/70 dark:text-blue-200/70">
                        {command} · {session}
                    </div>
                    <NodePhaseLabel label={data.__phaseLabel} />
                </div>
                {data.cwd && (
                    <div className="fab-node-footer text-[10px] font-mono text-blue-700 dark:text-blue-200">
                        cwd: {data.cwd}
                    </div>
                )}
                <Handle type="source" position={Position.Right} />
            </div>
        </div>
    );
}
