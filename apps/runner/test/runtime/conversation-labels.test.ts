import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationLabelStore } from '../../src/runtime/conversation-labels.js';

describe('createConversationLabelStore', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-conv-labels-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('set/get round-trip (trimmed)', () => {
        const store = createConversationLabelStore({ dir });
        expect(store.get('g1', 'a1', 'c1')).toBeUndefined();
        store.set('g1', 'a1', 'c1', '  My chat  ');
        expect(store.get('g1', 'a1', 'c1')).toBe('My chat');
        expect(store.getAllForGraph('g1')).toEqual({ 'a1:c1': 'My chat' });
    });

    it('empty / whitespace label clears the entry', () => {
        const store = createConversationLabelStore({ dir });
        store.set('g1', 'a1', 'c1', 'named');
        expect(store.get('g1', 'a1', 'c1')).toBe('named');
        store.set('g1', 'a1', 'c1', '   ');
        expect(store.get('g1', 'a1', 'c1')).toBeUndefined();
        expect(store.getAllForGraph('g1')).toEqual({});
    });

    it('delete removes one entry, leaving others', () => {
        const store = createConversationLabelStore({ dir });
        store.set('g1', 'a1', 'c1', 'one');
        store.set('g1', 'a1', 'c2', 'two');
        store.delete('g1', 'a1', 'c1');
        expect(store.get('g1', 'a1', 'c1')).toBeUndefined();
        expect(store.get('g1', 'a1', 'c2')).toBe('two');
    });

    it('isolates labels per graph file', () => {
        const store = createConversationLabelStore({ dir });
        store.set('g1', 'a1', 'c1', 'in-g1');
        store.set('g2', 'a1', 'c1', 'in-g2');
        expect(store.get('g1', 'a1', 'c1')).toBe('in-g1');
        expect(store.get('g2', 'a1', 'c1')).toBe('in-g2');
        expect(existsSync(join(dir, 'g1.json'))).toBe(true);
        expect(existsSync(join(dir, 'g2.json'))).toBe(true);
    });

    it('a fresh store over the same dir reloads prior writes from disk', () => {
        const a = createConversationLabelStore({ dir });
        a.set('g1', 'a1', 'c1', 'persisted');

        const b = createConversationLabelStore({ dir });
        expect(b.get('g1', 'a1', 'c1')).toBe('persisted');
        expect(b.getAllForGraph('g1')).toEqual({ 'a1:c1': 'persisted' });
    });

    it('deleteGraph removes the whole file (no-op if absent)', () => {
        const store = createConversationLabelStore({ dir });
        store.set('g1', 'a1', 'c1', 'doomed');
        expect(existsSync(join(dir, 'g1.json'))).toBe(true);
        store.deleteGraph('g1');
        expect(existsSync(join(dir, 'g1.json'))).toBe(false);
        expect(store.get('g1', 'a1', 'c1')).toBeUndefined();
        expect(() => store.deleteGraph('no-such-graph')).not.toThrow();
    });

    it('starts empty when an existing file is corrupt JSON', () => {
        writeFileSync(join(dir, 'bad.json'), '{ not json', 'utf8');
        const store = createConversationLabelStore({ dir });
        expect(store.getAllForGraph('bad')).toEqual({});
        store.set('bad', 'a1', 'c1', 'recovered');
        const fresh = createConversationLabelStore({ dir });
        expect(fresh.get('bad', 'a1', 'c1')).toBe('recovered');
    });
});
