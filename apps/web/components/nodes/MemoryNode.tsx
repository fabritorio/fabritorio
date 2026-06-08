'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MemoryNode as MemoryNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { MEMORY_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<MemoryNodeData> & { __state?: NodeExecState };
};

const STORAGE_KIND_LABEL: Record<NonNullable<MemoryNodeData['storage_kind']>, string> = {
    kv: 'kv',
    markdown: 'markdown',
    static_string: 'static',
};

const HANDLING_LABEL: Record<NonNullable<MemoryNodeData['handling']>, string> = {
    none: 'none',
    always_inject: 'inject',
    full_history: 'history',
    last_n: 'last_n',
    last_within_tokens: 'last_within_tokens',
};

const TOOL_ACCESS_LABEL: Record<NonNullable<MemoryNodeData['tool_access']>, string> = {
    none: 'no tools',
    read: 'read tool',
    read_write: 'read+write tools',
};

export function MemoryNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const storage = data.storage ?? 'in_memory';
    const storageKind = data.storage_kind ?? 'kv';
    const handling = data.handling ?? 'full_history';
    const toolAccess = data.tool_access ?? 'none';
    const storageLabel = storage === 'local_storage' ? 'local (file-backed)' : 'in-memory';
    const handlingLabel =
        handling === 'last_n'
            ? `last_n=${typeof data.n === 'number' && data.n > 0 ? data.n : 20}`
            : handling === 'last_within_tokens'
              ? `last_within_tokens=${typeof data.token_budget === 'number' && data.token_budget > 0 ? data.token_budget : 8192}`
              : HANDLING_LABEL[handling];
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('memory', state)}`}>
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-violet-700 dark:text-violet-300">
                    Memory
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-violet-950 dark:text-white">
                    {storageLabel}
                </div>
                <div className="text-xs text-violet-700/70 dark:text-violet-200/70">
                    {STORAGE_KIND_LABEL[storageKind]} · {handlingLabel} ·{' '}
                    {TOOL_ACCESS_LABEL[toolAccess]}
                </div>
            </div>
            <Handle id={MEMORY_PORTS.out.id} type="source" position={Position.Right} />
        </div>
    );
}
