import { describe, it, expect } from 'vitest';
import { createDispatchAbortRegistry } from '../../src/runtime/dispatch-aborts.js';

describe('DispatchAbortRegistry', () => {
    it('mint→get returns the same controller', () => {
        const reg = createDispatchAbortRegistry();
        const controller = reg.mint('evt-1');
        expect(reg.get('evt-1')).toBe(controller);
        expect(controller.signal.aborted).toBe(false);
    });

    it('abort trips the signal and returns true', () => {
        const reg = createDispatchAbortRegistry();
        const controller = reg.mint('evt-1');
        expect(reg.abort('evt-1')).toBe(true);
        expect(controller.signal.aborted).toBe(true);
    });

    it('abort on an unknown id returns false', () => {
        const reg = createDispatchAbortRegistry();
        expect(reg.abort('nope')).toBe(false);
    });

    it('release removes the controller', () => {
        const reg = createDispatchAbortRegistry();
        reg.mint('evt-1');
        reg.release('evt-1');
        expect(reg.get('evt-1')).toBeUndefined();
        expect(reg.abort('evt-1')).toBe(false);
    });

    it('chains child→parent: aborting the parent trips the child (Phase 4 cascade)', () => {
        const reg = createDispatchAbortRegistry();
        reg.mint('parent-1');
        const child = reg.mint('child-1', 'parent-1');
        expect(reg.abort('parent-1')).toBe(true);
        expect(child.signal.aborted).toBe(true);
    });

    it('does not chain when the parent is not registered', () => {
        const reg = createDispatchAbortRegistry();
        const child = reg.mint('child-1', 'ghost-parent');
        expect(child.signal.aborted).toBe(false);
    });

    it('chains immediately when the parent is already aborted at mint time', () => {
        const reg = createDispatchAbortRegistry();
        reg.mint('parent-1');
        reg.abort('parent-1');
        const child = reg.mint('child-1', 'parent-1');
        expect(child.signal.aborted).toBe(true);
    });

    it('release detaches the chain: a released child is untouched by a later parent abort', () => {
        const reg = createDispatchAbortRegistry();
        reg.mint('parent-1');
        const child = reg.mint('child-1', 'parent-1');
        reg.release('child-1');
        reg.abort('parent-1');
        expect(child.signal.aborted).toBe(false);
    });

    it('does not leak listeners on a long-lived parent across many children', () => {
        const reg = createDispatchAbortRegistry();
        const parent = reg.mint('parent-1');
        let aborted = 0;
        for (let i = 0; i < 1000; i++) {
            const child = reg.mint(`child-${i}`, 'parent-1');
            child.signal.addEventListener('abort', () => {
                aborted += 1;
            });
            reg.release(`child-${i}`);
        }
        parent.abort();
        expect(aborted).toBe(0);
    });
});
