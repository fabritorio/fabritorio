import type { Graph, Node } from '@fabritorio/types';
import { extractFragment, type Fragment } from './subgraph';

export const FABRITORIO_CLIPBOARD_VERSION = 1;

export interface ClipboardEnvelope {
    fabritorio: typeof FABRITORIO_CLIPBOARD_VERSION;
    kind: Fragment['kind'];
    fragment: Fragment;
}

export interface PastedGraph {
    graph: Graph;
    remap: Record<string, string>;
    addedNodeIds: string[];
}

export function serializeFragment(fragment: Fragment): string {
    const env: ClipboardEnvelope = {
        fabritorio: FABRITORIO_CLIPBOARD_VERSION,
        kind: fragment.kind,
        fragment,
    };
    return JSON.stringify(env);
}

export function parseClipboardFragment(text: string): Fragment | null {
    if (!text) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { fabritorio?: unknown }).fabritorio !== FABRITORIO_CLIPBOARD_VERSION
    ) {
        return null;
    }
    const env = parsed as Partial<ClipboardEnvelope>;
    const frag = env.fragment;
    if (
        !frag ||
        typeof frag !== 'object' ||
        typeof (frag as Fragment).kind !== 'string' ||
        !Array.isArray((frag as Fragment).nodes) ||
        !Array.isArray((frag as Fragment).edges)
    ) {
        return null;
    }
    return frag as Fragment;
}

export type CloneSubtreeFn = (fragment: Fragment) => Promise<{
    graph: Graph;
    remap: Record<string, string>;
}>;

function offsetFragment(fragment: Fragment, offset: { x: number; y: number }): Fragment {
    return {
        ...fragment,
        nodes: fragment.nodes.map(
            (n) =>
                ({
                    ...n,
                    position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
                }) as Node,
        ),
    };
}

export async function buildPastedGraph(
    currentGraph: Graph,
    clipboardText: string,
    offset: { x: number; y: number },
    cloneSubtree: CloneSubtreeFn,
): Promise<PastedGraph | null> {
    const fragment = parseClipboardFragment(clipboardText);
    if (!fragment) return null;
    if (fragment.kind !== currentGraph.kind) {
        throw new Error(
            `kind mismatch: fragment is ${fragment.kind}, target is ${currentGraph.kind}`,
        );
    }
    if (fragment.nodes.length === 0) {
        return { graph: currentGraph, remap: {}, addedNodeIds: [] };
    }
    const { graph, remap } = await cloneSubtree(offsetFragment(fragment, offset));
    const finalIds = new Set(graph.nodes.map((n) => n.id));
    const addedNodeIds = fragment.nodes
        .map((n) => remap[n.id] ?? n.id)
        .filter((finalId) => finalIds.has(finalId));
    return { graph, remap, addedNodeIds };
}

export { extractFragment };
