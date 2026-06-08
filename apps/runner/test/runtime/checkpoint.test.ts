import { describe, expect, it } from 'vitest';
import { interpretSupervisor } from '../../src/runtime/checkpoint.js';

describe('interpretSupervisor', () => {
    it('returns no branch on continue — "continue" is not a handler-graph port', () => {
        expect(interpretSupervisor('continue')).toEqual({});
        expect(interpretSupervisor('CONTINUE — looks productive')).toEqual({});
    });

    it('routes an explicit stop to the real done port', () => {
        expect(interpretSupervisor('stop')).toEqual({ branch: 'done' });
        expect(interpretSupervisor('The agent is stuck in a loop. stop.')).toEqual({
            branch: 'done',
        });
    });

    it('fails open (no branch) when the verdict is ambiguous or empty', () => {
        expect(interpretSupervisor('')).toEqual({});
        expect(interpretSupervisor('unsure, hard to tell')).toEqual({});
        expect(interpretSupervisor('do not stop, continue')).toEqual({});
    });
});
