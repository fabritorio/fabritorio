'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ToolPackNode as ToolPackNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { TOOL_PACK_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<ToolPackNodeData> & { __state?: NodeExecState };
};

export function ToolPackNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const label = data.pack_name && data.pack_name.length > 0 ? data.pack_name : '(unnamed pack)';
    const refHint = data.ref_id ? `→ ${data.ref_id.slice(0, 8)}` : 'inline';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('tool_pack', state)}`}>
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-yellow-800 dark:text-yellow-200">
                    Tool Pack
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-mono font-medium text-slate-950 dark:text-white">
                    {label}
                </div>
                <div className="text-xs text-slate-600/70 dark:text-slate-200/70">{refHint}</div>
            </div>
            <div className="fab-node-footer text-[10px] text-slate-600 dark:text-slate-200">
                double-click to drill in
            </div>
            <Handle id={TOOL_PACK_PORTS.secretsIn.id} type="target" position={Position.Left} />
            <Handle id={TOOL_PACK_PORTS.toolOut.id} type="source" position={Position.Right} />
        </div>
    );
}
