import { describe, expect, it } from 'vitest';
import {
    bumpGlow,
    decay,
    GLOW_BUMP_CONTENT,
    GLOW_BUMP_REASONING,
    GLOW_HALF_LIFE_MS,
    GLOW_MAX,
} from '../lib/node-liveness';

describe('node-liveness decay', () => {
    it('halves the value over one half-life', () => {
        expect(decay(1, GLOW_HALF_LIFE_MS, GLOW_HALF_LIFE_MS)).toBeCloseTo(0.5, 5);
        expect(decay(0.8, 2 * GLOW_HALF_LIFE_MS, GLOW_HALF_LIFE_MS)).toBeCloseTo(0.2, 5);
    });

    it('is framerate-independent: decay composes additively in elapsed time', () => {
        const hl = GLOW_HALF_LIFE_MS;
        const oneStep = decay(1, 100, hl);
        const twoHalfSteps = decay(decay(1, 50, hl), 50, hl);
        expect(twoHalfSteps).toBeCloseTo(oneStep, 6);
    });

    it('clamps non-positive value and elapsed', () => {
        expect(decay(0, 100, GLOW_HALF_LIFE_MS)).toBe(0);
        expect(decay(-1, 100, GLOW_HALF_LIFE_MS)).toBe(0);
        expect(decay(0.5, 0, GLOW_HALF_LIFE_MS)).toBe(0.5);
        expect(decay(0.5, -10, GLOW_HALF_LIFE_MS)).toBe(0.5);
    });
});

describe('node-liveness bumpGlow', () => {
    it('adds the content increment from zero', () => {
        expect(bumpGlow(0, 'content')).toBeCloseTo(GLOW_BUMP_CONTENT, 5);
    });

    it('reasoning bumps less than content (dimmer thinking track)', () => {
        expect(bumpGlow(0, 'reasoning')).toBeCloseTo(GLOW_BUMP_REASONING, 5);
        expect(GLOW_BUMP_REASONING).toBeLessThan(GLOW_BUMP_CONTENT);
    });

    it('saturates at the ceiling under a burst', () => {
        let g = 0;
        for (let i = 0; i < 20; i++) g = bumpGlow(g, 'content');
        expect(g).toBe(GLOW_MAX);
    });
});
