'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SecretsNode as SecretsNodeData } from '@fabritorio/types';
import type { NodeExecState } from '@/lib/node-state';
import { nodeStateClassName } from '@/lib/node-style';
import { SECRETS_PORTS } from '@/lib/ports';

type Props = NodeProps & {
    data: Partial<SecretsNodeData> & { __state?: NodeExecState };
};

export function SecretsNode({ data }: Props) {
    const state = data.__state ?? 'idle';
    const count = data.bindings?.length ?? 0;
    return (
        <div className={`min-w-[200px] ${nodeStateClassName('secrets', state)}`}>
            <div className="fab-node-header">
                <span className="text-[10px] uppercase tracking-wider font-medium text-slate-700 dark:text-slate-300">
                    Secrets
                </span>
                <span className="font-mono text-[9px] px-1.5 py-px rounded bg-black/5 dark:bg-white/10">
                    {state}
                </span>
            </div>
            <div className="fab-node-body">
                <div className="text-sm font-medium text-slate-950 dark:text-white">
                    {`\u{1F512} ${count} ${count === 1 ? 'key' : 'keys'}`}
                </div>
            </div>
            <Handle id={SECRETS_PORTS.secretsOut.id} type="source" position={Position.Right} />
        </div>
    );
}
