import { describe, it, expect } from 'vitest';
import {
    buildCrumbHref,
    buildStepIntoHref,
    parseFromParam,
    parseLocationToDrillState,
    pushDrill,
    serializeFromParam,
    truncateDrill,
} from '../lib/breadcrumb-stack';

describe('parseFromParam', () => {
    it('returns [] for null/empty', () => {
        expect(parseFromParam(null)).toEqual([]);
        expect(parseFromParam(undefined)).toEqual([]);
        expect(parseFromParam('')).toEqual([]);
    });

    it('parses comma-joined ids', () => {
        expect(parseFromParam('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('decodes percent-encoded ids', () => {
        expect(parseFromParam('a%2Cb,c')).toEqual(['a,b', 'c']);
    });

    it('drops empty segments', () => {
        expect(parseFromParam(',a,,b,')).toEqual(['a', 'b']);
    });
});

describe('serializeFromParam', () => {
    it('joins with commas and percent-encodes', () => {
        expect(serializeFromParam(['a', 'b'])).toBe('a,b');
        expect(serializeFromParam(['a,b', 'c'])).toBe('a%2Cb,c');
    });

    it('emits empty for empty stack', () => {
        expect(serializeFromParam([])).toBe('');
    });
});

describe('buildStepIntoHref', () => {
    it('appends current to from when from is empty', () => {
        expect(buildStepIntoHref('ref', 'current', null)).toBe('/graphs/ref?from=current');
    });

    it('appends current to existing chain', () => {
        expect(buildStepIntoHref('ref', 'current', 'root,middle')).toBe(
            '/graphs/ref?from=root,middle,current',
        );
    });

    it('truncates the stack on cycles', () => {
        expect(buildStepIntoHref('root', 'current', 'root,middle')).toBe('/graphs/root');
    });

    it('truncates partial cycles', () => {
        expect(buildStepIntoHref('middle', 'current', 'root,middle,other')).toBe(
            '/graphs/middle?from=root',
        );
    });

    it('noops self-step (target === current)', () => {
        expect(buildStepIntoHref('same', 'same', 'root')).toBe('/graphs/same?from=root');
    });

    it('URL-encodes ids', () => {
        expect(buildStepIntoHref('a/b', 'c d', null)).toBe('/graphs/a%2Fb?from=c%20d');
    });
});

describe('buildCrumbHref', () => {
    it('returns href for an ancestor without trailing chain', () => {
        expect(buildCrumbHref(['root', 'middle', 'leaf'], 0)).toBe('/graphs/root');
        expect(buildCrumbHref(['root', 'middle', 'leaf'], 1)).toBe('/graphs/middle?from=root');
        expect(buildCrumbHref(['root', 'middle', 'leaf'], 2)).toBe('/graphs/leaf?from=root,middle');
    });

    it('falls back to / for out-of-range index', () => {
        expect(buildCrumbHref(['root'], 5)).toBe('/');
    });
});

describe('pushDrill', () => {
    it('appends current when target is new (empty + non-empty stack)', () => {
        expect(pushDrill([], 'current', 'ref')).toEqual(['current']);
        expect(pushDrill(['root', 'middle'], 'current', 'ref')).toEqual([
            'root',
            'middle',
            'current',
        ]);
    });

    it('walks back to a fully-cycled target (drops it + everything after)', () => {
        expect(pushDrill(['root', 'middle'], 'current', 'root')).toEqual([]);
    });

    it('truncates a partial cycle', () => {
        expect(pushDrill(['root', 'middle', 'other'], 'current', 'middle')).toEqual(['root']);
    });

    it('leaves the stack untouched on self-step (target === current)', () => {
        expect(pushDrill(['root'], 'same', 'same')).toEqual(['root']);
    });

    it('agrees with buildStepIntoHref for every transition shape', () => {
        const check = (stack: string[], current: string, target: string) => {
            const nextStack = pushDrill(stack, current, target);
            const href = buildStepIntoHref(target, current, serializeFromParam(stack));
            const qs = serializeFromParam(nextStack);
            expect(href).toBe(
                qs.length > 0
                    ? `/graphs/${encodeURIComponent(target)}?from=${qs}`
                    : `/graphs/${encodeURIComponent(target)}`,
            );
        };
        check([], 'current', 'ref');
        check(['root', 'middle'], 'current', 'ref');
        check(['root', 'middle'], 'current', 'root');
        check(['root', 'middle', 'other'], 'current', 'middle');
        check(['root'], 'same', 'same');
    });
});

describe('truncateDrill', () => {
    it('keeps only the ancestors before the clicked index', () => {
        expect(truncateDrill(['root', 'middle', 'leaf'], 0)).toEqual([]);
        expect(truncateDrill(['root', 'middle', 'leaf'], 1)).toEqual(['root']);
        expect(truncateDrill(['root', 'middle', 'leaf'], 2)).toEqual(['root', 'middle']);
    });

    it('returns [] for an out-of-range index (mirrors buildCrumbHref `/` fallback)', () => {
        expect(truncateDrill(['root'], 5)).toEqual([]);
        expect(truncateDrill(['root'], -1)).toEqual([]);
    });
});

describe('parseLocationToDrillState', () => {
    it('reads the id from the last path segment + the from trail', () => {
        expect(parseLocationToDrillState('/graphs/leaf', '?from=root,middle')).toEqual({
            currentGraphId: 'leaf',
            fromStack: ['root', 'middle'],
        });
    });

    it('handles an empty search (no trail)', () => {
        expect(parseLocationToDrillState('/graphs/leaf', '')).toEqual({
            currentGraphId: 'leaf',
            fromStack: [],
        });
    });

    it('URL-decodes the id and the trail', () => {
        expect(parseLocationToDrillState('/graphs/a%2Fb', '?from=c%20d')).toEqual({
            currentGraphId: 'a/b',
            fromStack: ['c d'],
        });
    });

    it('yields a null id for the static-export `_` placeholder', () => {
        expect(parseLocationToDrillState('/graphs/_', '')).toEqual({
            currentGraphId: null,
            fromStack: [],
        });
    });

    it('yields a null id for a non-/graphs path', () => {
        expect(parseLocationToDrillState('/', '')).toEqual({
            currentGraphId: null,
            fromStack: [],
        });
    });

    it('round-trips a buildStepIntoHref URL back to the pushed stack', () => {
        const href = buildStepIntoHref('ref', 'current', 'root,middle');
        const [pathname, search] = href.split('?');
        expect(parseLocationToDrillState(pathname!, search ? `?${search}` : '')).toEqual({
            currentGraphId: 'ref',
            fromStack: pushDrill(['root', 'middle'], 'current', 'ref'),
        });
    });
});
