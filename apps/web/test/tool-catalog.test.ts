import { describe, expect, it } from 'vitest';
import type { ToolSpecSummary } from '../lib/runner-client';
import { groupToolsBySource } from '../lib/tool-catalog';

const tool = (name: string, source?: ToolSpecSummary['source']): ToolSpecSummary => ({
    name,
    description: `desc for ${name}`,
    source,
});

describe('groupToolsBySource', () => {
    it('splits a mixed catalog into builtin and runtime buckets', () => {
        const result = groupToolsBySource([
            tool('read_file', 'builtin'),
            tool('linear_query', 'runtime'),
            tool('write_file', 'builtin'),
            tool('echo', 'runtime'),
        ]);
        expect(result.builtin.map((t) => t.name)).toEqual(['read_file', 'write_file']);
        expect(result.runtime.map((t) => t.name)).toEqual(['linear_query', 'echo']);
    });

    it('returns an empty runtime bucket when only built-ins are present', () => {
        const result = groupToolsBySource([
            tool('read_file', 'builtin'),
            tool('write_file', 'builtin'),
        ]);
        expect(result.runtime).toEqual([]);
        expect(result.builtin).toHaveLength(2);
    });

    it('treats tools without a `source` field as built-in (older runners)', () => {
        const result = groupToolsBySource([tool('legacy_tool'), tool('echo', 'runtime')]);
        expect(result.builtin.map((t) => t.name)).toEqual(['legacy_tool']);
        expect(result.runtime.map((t) => t.name)).toEqual(['echo']);
    });
});
