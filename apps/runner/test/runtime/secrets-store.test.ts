import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretsStore } from '../../src/runtime/secrets-store.js';

describe('createSecretsStore', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-secrets-'));
        path = join(dir, 'secrets.env');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('get / has reflect the file contents', () => {
        writeFileSync(path, 'STRIPE_SECRET_KEY=sk-test-123\nLINEAR_TOKEN=lin_abc\n');
        const store = createSecretsStore({ path });
        expect(store.get('STRIPE_SECRET_KEY')).toBe('sk-test-123');
        expect(store.has('STRIPE_SECRET_KEY')).toBe(true);
        expect(store.get('LINEAR_TOKEN')).toBe('lin_abc');
        expect(store.has('LINEAR_TOKEN')).toBe(true);
        expect(store.get('NOPE')).toBeUndefined();
        expect(store.has('NOPE')).toBe(false);
    });

    it('a missing file yields an empty store without throwing', () => {
        const store = createSecretsStore({ path: join(dir, 'does-not-exist.env') });
        expect(store.get('ANYTHING')).toBeUndefined();
        expect(store.has('ANYTHING')).toBe(false);
        expect(store.values()).toEqual([]);
    });

    it('ignores comments and blank lines', () => {
        writeFileSync(
            path,
            '# a comment\n\nDEMO_TOKEN=sk-test-123\n   \n# trailing comment\nOTHER=value\n',
        );
        const store = createSecretsStore({ path });
        expect(store.get('DEMO_TOKEN')).toBe('sk-test-123');
        expect(store.get('OTHER')).toBe('value');
        expect(store.has('# a comment')).toBe(false);
        expect(store.values().sort()).toEqual(['sk-test-123', 'value']);
    });

    it('rescan() reflects a rotated value AND a newly added key (hot reload)', () => {
        writeFileSync(path, 'DEMO_TOKEN=sk-test-123\n');
        const store = createSecretsStore({ path });
        expect(store.get('DEMO_TOKEN')).toBe('sk-test-123');
        expect(store.has('LATE_KEY')).toBe(false);

        writeFileSync(path, 'DEMO_TOKEN=sk-test-999\nLATE_KEY=added-later\n');

        expect(store.get('DEMO_TOKEN')).toBe('sk-test-123');
        expect(store.has('LATE_KEY')).toBe(false);

        store.rescan();
        expect(store.get('DEMO_TOKEN')).toBe('sk-test-999');
        expect(store.get('LATE_KEY')).toBe('added-later');
        expect(store.has('LATE_KEY')).toBe(true);
    });
});
