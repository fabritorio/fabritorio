import type { PromptBuilderNode } from '@fabritorio/types';
import { HeaderRow } from '../shared';

export function PromptBuilderInspector({ node }: { node: PromptBuilderNode }) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Prompt Builder" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Assembles the initial messages buffer: Model.system_prompt + skill summaries +
                inbound messages. Fires once per Dispatch.
            </p>
        </div>
    );
}
