import { describe, it, expect } from 'vitest';
import {
    OPTIMISTIC_EDGE_ERROR_CLASS,
    OPTIMISTIC_EDGE_PENDING_CLASS,
    OPTIMISTIC_ERROR_DISSOLVE_MS,
    OPTIMISTIC_NODE_ERROR_CLASS,
    OPTIMISTIC_NODE_PENDING_CLASS,
    useOptimisticGhosts,
} from '../lib/optimistic-ghost';

describe('optimistic-ghost', () => {
    it('exposes the same class names the Canvas references and globals.css rules', () => {
        expect(OPTIMISTIC_NODE_PENDING_CLASS).toBe('fabritorio-optimistic-pending-node');
        expect(OPTIMISTIC_NODE_ERROR_CLASS).toBe('fabritorio-optimistic-error-node');
        expect(OPTIMISTIC_EDGE_PENDING_CLASS).toBe('fabritorio-optimistic-pending-edge');
        expect(OPTIMISTIC_EDGE_ERROR_CLASS).toBe('fabritorio-optimistic-error-edge');
    });

    it('exports a finite dissolve timeout the canvas uses to clear failed ghosts', () => {
        expect(OPTIMISTIC_ERROR_DISSOLVE_MS).toBeGreaterThan(0);
        expect(OPTIMISTIC_ERROR_DISSOLVE_MS).toBeLessThan(5_000);
    });

    it('useOptimisticGhosts is exported as a function (DOM-level behavior tested via integration)', () => {
        expect(typeof useOptimisticGhosts).toBe('function');
    });
});
