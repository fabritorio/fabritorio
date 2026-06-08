'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SkillNode as SkillNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { SKILL_PORTS } from '@/lib/ports';

type SkillNodeProps = NodeProps & {
    data: Partial<SkillNodeData> & { __state?: NodeExecState };
};

export function SkillNode({ data }: SkillNodeProps) {
    const state = data.__state ?? 'idle';
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('skill', state)}`}>
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-purple-700 dark:text-purple-300">
                    Skill
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-purple-950 dark:text-white">
                    {data.name ? data.name : '(no skill selected)'}
                </div>
            </div>
            <div className="fab-node-footer text-xs text-purple-700 dark:text-purple-200">
                permission gate
            </div>
            <Handle id={SKILL_PORTS.skillOut.id} type="source" position={Position.Right} />
        </div>
    );
}
