import type { GraphKind, NodeType } from '@fabritorio/types';
import { STARTER_IDS } from '@fabritorio/types';
import { instantiateLibraryGraph } from './instantiate.js';
import type { Op } from './ops.js';
import type { GraphStore } from './store.js';

interface MintSpec {
    graphKind: GraphKind;
    refField: 'l1_graph_id' | 'ref_id';
}

export const MINT: Partial<Record<NodeType, MintSpec>> = {
    native_agent: { graphKind: 'l1', refField: 'l1_graph_id' },
    tool_pack: { graphKind: 'toolpack', refField: 'ref_id' },
    skill_pack: { graphKind: 'skillpack', refField: 'ref_id' },
};

export async function mintMissingRefs(store: GraphStore, ops: Op[]): Promise<{ minted: string[] }> {
    const minted: string[] = [];
    for (const op of ops) {
        if (op.op !== 'add_node') continue;
        const spec = MINT[op.kind];
        if (!spec) continue;
        const existing = op.config?.[spec.refField];
        if (typeof existing === 'string' && existing) continue;
        const { copy } = await instantiateLibraryGraph(store, STARTER_IDS[spec.graphKind]);
        op.config = { ...op.config, [spec.refField]: copy.id };
        minted.push(copy.id!);
    }
    return { minted };
}
