import type {
    ConnectionRule,
    GraphKind,
    NodeType,
    Palette,
    PaletteNodeSpec,
} from '@fabritorio/types';
import { getDefaultBaseUrl } from './runner-client';

let cached: Palette | null = null;
let inflight: Promise<Palette> | null = null;

export function getCachedPalette(): Palette | null {
    return cached;
}

export async function loadPalette(baseUrl: string = getDefaultBaseUrl()): Promise<Palette> {
    if (cached) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const res = await fetch(`${baseUrl}/palette`);
            if (!res.ok) throw new Error(`palette fetch failed: ${res.status}`);
            const body = (await res.json()) as Palette;
            cached = body;
            return body;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

export function __setCachedPaletteForTest(p: Palette | null): void {
    cached = p;
}

export function paletteNodeSpec(type: NodeType): PaletteNodeSpec | null {
    if (!cached) return null;
    return cached.nodes[type] ?? null;
}

export function paletteAllowedNodeTypes(kind: GraphKind): ReadonlySet<NodeType> | null {
    if (!cached) return null;
    const spec = cached.compositeKinds[kind];
    if (!spec) return null;
    return new Set(spec.allowedNodeTypes);
}

export function findConnectionRule(
    kind: GraphKind,
    source: NodeType,
    target: NodeType,
): ConnectionRule | null {
    if (!cached) return null;
    const rules = cached.connections[kind] ?? [];
    for (const rule of rules) {
        if (rule.source === source && rule.target === target) return rule;
    }
    return null;
}

export function findRuleBySource(kind: GraphKind, sourceType: NodeType): ConnectionRule | null {
    if (!cached) return null;
    const rules = cached.connections[kind] ?? [];
    for (const rule of rules) {
        if (rule.source === sourceType) return rule;
    }
    return null;
}

export function findRuleByTarget(kind: GraphKind, targetType: NodeType): ConnectionRule | null {
    if (!cached) return null;
    const rules = cached.connections[kind] ?? [];
    for (const rule of rules) {
        if (rule.target === targetType) return rule;
    }
    return null;
}
