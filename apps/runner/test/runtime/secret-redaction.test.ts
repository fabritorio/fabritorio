import { describe, it, expect } from 'vitest';
import { redactSecrets, REDACTION_PLACEHOLDER } from '../../src/runtime/secret-redaction.js';

describe('redactSecrets', () => {
    it('replaces an exact value occurrence with the placeholder', () => {
        expect(redactSecrets('token=sk-test-123', ['sk-test-123'])).toBe(
            `token=${REDACTION_PLACEHOLDER}`,
        );
    });

    it('replaces every occurrence of a value', () => {
        expect(redactSecrets('sk-1 then sk-1 again sk-1', ['sk-1'])).toBe(
            `${REDACTION_PLACEHOLDER} then ${REDACTION_PLACEHOLDER} again ${REDACTION_PLACEHOLDER}`,
        );
    });

    it('redacts multiple distinct values', () => {
        expect(redactSecrets('a=AAA b=BBB', ['AAA', 'BBB'])).toBe(
            `a=${REDACTION_PLACEHOLDER} b=${REDACTION_PLACEHOLDER}`,
        );
    });

    it('ignores empty-string values (a blank secret must not nuke all output)', () => {
        const text = 'unrelated output';
        expect(redactSecrets(text, [''])).toBe(text);
        expect(redactSecrets('x=SECRET', ['', 'SECRET'])).toBe(`x=${REDACTION_PLACEHOLDER}`);
    });

    it('is a no-op on an empty value-set', () => {
        const text = 'token=sk-test-123';
        expect(redactSecrets(text, [])).toBe(text);
    });

    it('leaves text without any matching value unchanged', () => {
        expect(redactSecrets('nothing secret here', ['sk-unused'])).toBe('nothing secret here');
    });
});
