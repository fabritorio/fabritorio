export const FROM_PARAM = 'from';

export function parseFromParam(value: string | null | undefined): string[] {
    if (!value) return [];
    return value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => {
            try {
                return decodeURIComponent(s);
            } catch {
                return s;
            }
        });
}

export function serializeFromParam(stack: ReadonlyArray<string>): string {
    return stack
        .filter((s) => s.length > 0)
        .map((s) => encodeURIComponent(s))
        .join(',');
}

export function buildStepIntoHref(
    targetId: string,
    currentId: string,
    currentFrom: string | null | undefined,
): string {
    const stack = parseFromParam(currentFrom);
    const cycleAt = stack.indexOf(targetId);
    let nextStack: string[];
    if (cycleAt >= 0) {
        nextStack = stack.slice(0, cycleAt);
    } else if (targetId === currentId) {
        nextStack = stack;
    } else {
        nextStack = [...stack, currentId];
    }
    const qs = serializeFromParam(nextStack);
    const base = `/graphs/${encodeURIComponent(targetId)}`;
    return qs.length > 0 ? `${base}?${FROM_PARAM}=${qs}` : base;
}

export function buildCrumbHref(stack: ReadonlyArray<string>, index: number): string {
    const target = stack[index];
    if (!target) return '/';
    const ancestors = stack.slice(0, index);
    const qs = serializeFromParam(ancestors);
    const base = `/graphs/${encodeURIComponent(target)}`;
    return qs.length > 0 ? `${base}?${FROM_PARAM}=${qs}` : base;
}

export function pushDrill(
    fromStack: ReadonlyArray<string>,
    currentId: string,
    targetId: string,
): string[] {
    const cycleAt = fromStack.indexOf(targetId);
    if (cycleAt >= 0) return fromStack.slice(0, cycleAt);
    if (targetId === currentId) return [...fromStack];
    return [...fromStack, currentId];
}

export function truncateDrill(stack: ReadonlyArray<string>, index: number): string[] {
    if (index < 0 || index >= stack.length) return [];
    return stack.slice(0, index);
}

export interface DrillState {
    currentGraphId: string | null;
    fromStack: string[];
}

export function parseLocationToDrillState(pathname: string, search: string): DrillState {
    const segments = pathname.split('/').filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    const isGraphRoute = segments[0] === 'graphs' && segments.length >= 2;
    let currentGraphId: string | null = null;
    if (isGraphRoute && last && last !== '_') {
        try {
            currentGraphId = decodeURIComponent(last);
        } catch {
            currentGraphId = last;
        }
    }
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const fromStack = parseFromParam(params.get(FROM_PARAM));
    return { currentGraphId, fromStack };
}
