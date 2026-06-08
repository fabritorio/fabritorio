import type { EvaluatorNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function EvaluatorInspector({ node }: { node: EvaluatorNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Evaluator" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Branches on the last assistant message: <code className="font-mono">tools</code>{' '}
                port if it has tool_calls, <code className="font-mono">done</code> port if it's
                text-only.
            </p>
        </div>
    );
}
