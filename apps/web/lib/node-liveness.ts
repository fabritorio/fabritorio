export const GLOW_MAX = 1;

export const GLOW_BUMP_CONTENT = 0.6;
export const GLOW_BUMP_REASONING = 0.35;

export const GLOW_HALF_LIFE_MS = 280;

export const PHOSPHOR_HALF_LIFE_MS = 750;

export function decay(value: number, elapsedMs: number, halfLifeMs: number): number {
    if (value <= 0) return 0;
    if (elapsedMs <= 0) return value;
    return value * Math.pow(0.5, elapsedMs / halfLifeMs);
}

export function bumpGlow(current: number, kind: 'content' | 'reasoning'): number {
    const inc = kind === 'reasoning' ? GLOW_BUMP_REASONING : GLOW_BUMP_CONTENT;
    return Math.min(GLOW_MAX, current + inc);
}

export const LIVENESS_EPSILON = 0.01;
