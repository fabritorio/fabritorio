import { describe, it, expect } from 'vitest';
import {
    buildSystemPrompt,
    resolveSystemPrompt,
} from '../../../src/runtime/handlers/system-prompt.js';

describe('buildSystemPrompt', () => {
    it('concatenates model prompt and skill catalog', () => {
        const prompt = buildSystemPrompt({
            modelSystemPrompt: 'You are helpful.',
            skills: [
                { name: 'fixer', description: 'fixes things' },
                { name: 'tester', description: 'writes tests' },
            ],
        });
        expect(prompt).toContain('You are helpful.');
        expect(prompt).toContain('Available skills');
        expect(prompt).toContain('- fixer: fixes things');
        expect(prompt).toContain('- tester: writes tests');
    });

    it('omits skill block when no skills wired', () => {
        expect(buildSystemPrompt({ modelSystemPrompt: 'be terse', skills: [] })).toBe('be terse');
    });

    it('returns empty string when no inputs', () => {
        expect(buildSystemPrompt({ skills: [] })).toBe('');
    });

    it('appends the injected memory block when present', () => {
        const prompt = buildSystemPrompt({
            modelSystemPrompt: 'be terse',
            skills: [],
            injectedMemoryBlock: 'remember: x=1',
        });
        expect(prompt).toBe('be terse\n\nremember: x=1');
    });
});

describe('resolveSystemPrompt', () => {
    it('returns a string prompt as-is', () => {
        expect(resolveSystemPrompt('static prompt')).toBe('static prompt');
    });

    it('calls a thunk and returns its value', () => {
        let calls = 0;
        const thunk = () => {
            calls++;
            return `rendered ${calls}`;
        };
        expect(resolveSystemPrompt(thunk)).toBe('rendered 1');
        expect(resolveSystemPrompt(thunk)).toBe('rendered 2');
    });
});
