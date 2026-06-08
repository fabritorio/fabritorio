import { describe, expect, it } from 'vitest';
import { extractReasoningDelta } from '../../src/runtime/model.js';

describe('extractReasoningDelta', () => {
    it('returns reasoning_content (DeepSeek / llama-server convention)', () => {
        expect(extractReasoningDelta({ reasoning_content: 'thinking…' })).toBe('thinking…');
    });

    it('falls back to plain reasoning field (some OpenRouter adapters)', () => {
        expect(extractReasoningDelta({ reasoning: 'alt field' })).toBe('alt field');
    });

    it('prefers reasoning_content over reasoning when both are present', () => {
        expect(
            extractReasoningDelta({
                reasoning_content: 'primary',
                reasoning: 'secondary',
            }),
        ).toBe('primary');
    });

    it('returns empty string when neither is set', () => {
        expect(extractReasoningDelta({ content: 'answer' })).toBe('');
        expect(extractReasoningDelta({})).toBe('');
        expect(extractReasoningDelta(null)).toBe('');
        expect(extractReasoningDelta(undefined)).toBe('');
    });

    it('ignores non-string reasoning fields', () => {
        expect(extractReasoningDelta({ reasoning_content: 42 })).toBe('');
        expect(extractReasoningDelta({ reasoning: { nested: 'x' } })).toBe('');
    });
});
