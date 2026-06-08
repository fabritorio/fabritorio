import type { SkillPackNode, ToolPackNode } from '@fabritorio/types';
import { useDrillNavigation } from '@/lib/useDrillNavigation';
import { Label, Input } from '../shared';

export interface PackRefPickerProps {
    node: ToolPackNode | SkillPackNode;
    currentGraphId: string | null;
}

export function PackRefPicker({ node, currentGraphId }: PackRefPickerProps) {
    const { drillInto } = useDrillNavigation();

    const openL0 = (l0Id: string) => {
        if (!currentGraphId) return;
        void drillInto(l0Id);
    };

    return (
        <div className="space-y-2">
            <div>
                <Label>Referenced L0 graph</Label>
                <Input value={node.ref_id ?? '(minting…)'} disabled readOnly />
            </div>
            {node.ref_id ? (
                <button
                    type="button"
                    disabled={!currentGraphId}
                    onClick={() => openL0(node.ref_id!)}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                    Open L0 graph
                </button>
            ) : null}
        </div>
    );
}
