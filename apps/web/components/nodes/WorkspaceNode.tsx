'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkspaceNode as WorkspaceNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { WORKSPACE_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<WorkspaceNodeData> & { __state?: NodeExecState };
};

export function WorkspaceNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const label = data.path && data.path.length > 0 ? data.path : '(no path)';
    const readOnly = data.permissions === 'read';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('workspace', state)}`}>
            <div className="fab-node-header">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium text-cyan-700 dark:text-cyan-300">
                    Workspace
                    {readOnly && (
                        <span className="rounded-sm bg-amber-200/80 px-1 text-[9px] uppercase tracking-wide text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">
                            read-only
                        </span>
                    )}
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="break-all text-sm font-mono font-medium text-slate-950 dark:text-white">
                    {label}
                </div>
            </div>
            <Handle id={WORKSPACE_PORTS.workspaceOut.id} type="source" position={Position.Right} />
        </div>
    );
}
