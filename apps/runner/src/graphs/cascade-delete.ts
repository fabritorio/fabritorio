import { refOf } from './invariant.js';
import type { GraphStore } from './store.js';

export async function deleteSubtree(
    store: GraphStore,
    rootId: string,
    opts: { includeRoot: boolean },
): Promise<string[]> {
    const visited = new Set<string>();
    const deleted: string[] = [];

    async function walk(id: string): Promise<void> {
        if (visited.has(id)) return;
        visited.add(id);
        const graph = await store.get(id);
        if (!graph) return;
        for (const node of graph.nodes) {
            const child = refOf(node);
            if (child) await walk(child);
        }
        if (id !== rootId || opts.includeRoot) {
            const ok = await store.delete(id);
            if (ok) deleted.push(id);
        }
    }

    await walk(rootId);
    return deleted;
}
