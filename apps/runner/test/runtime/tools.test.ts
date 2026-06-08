import { describe, it, expect } from 'vitest';
import {
    createDefaultToolRegistry,
    createToolRegistry,
    getCurrentTimeTool,
} from '../../src/runtime/tools.js';
import { mergeToolCallDeltas, finalizeToolCalls } from '../../src/runtime/model.js';

describe('tool registry', () => {
    it('lists registered tool specs', () => {
        const reg = createToolRegistry([getCurrentTimeTool]);
        const specs = reg.list();
        expect(specs).toHaveLength(1);
        expect(specs[0]!.name).toBe('get_current_time');
    });

    it('retrieves a tool by name', () => {
        const reg = createToolRegistry([getCurrentTimeTool]);
        const tool = reg.get('get_current_time');
        expect(tool?.spec.name).toBe('get_current_time');
        expect(reg.get('does_not_exist')).toBeUndefined();
    });

    it('register() adds/overwrites tools', () => {
        const reg = createToolRegistry();
        expect(reg.list()).toHaveLength(0);
        reg.register(getCurrentTimeTool);
        expect(reg.list()).toHaveLength(1);
        reg.register(getCurrentTimeTool);
        expect(reg.list()).toHaveLength(1);
    });

    it('default registry includes get_current_time', () => {
        const reg = createDefaultToolRegistry();
        expect(reg.get('get_current_time')).toBeDefined();
    });

    it('get_current_time handler returns an ISO timestamp on stdout', async () => {
        const result = await getCurrentTimeTool.handler({}, { call_id: 'c1', eventId: 'ev-1' });
        expect(result.exit_code).toBe(0);
        expect(result.stderr).toBe('');
        expect(() => new Date(result.stdout).toISOString()).not.toThrow();
    });
});

describe('mergeToolCallDeltas', () => {
    it('assembles a single tool call across fragmented deltas', () => {
        const accs = new Map();
        mergeToolCallDeltas(accs, [
            {
                index: 0,
                id: 'call_abc',
                function: { name: 'get_current_time', arguments: '' },
            },
        ]);
        mergeToolCallDeltas(accs, [{ index: 0, function: { arguments: '{' } }]);
        mergeToolCallDeltas(accs, [{ index: 0, function: { arguments: '}' } }]);
        const calls = finalizeToolCalls(accs);
        expect(calls).toEqual([{ id: 'call_abc', name: 'get_current_time', arguments: '{}' }]);
    });

    it('preserves parallel tool calls by index', () => {
        const accs = new Map();
        mergeToolCallDeltas(accs, [
            { index: 0, id: 'call_1', function: { name: 'a', arguments: '' } },
            { index: 1, id: 'call_2', function: { name: 'b', arguments: '' } },
        ]);
        mergeToolCallDeltas(accs, [
            { index: 0, function: { arguments: '{"x":1}' } },
            { index: 1, function: { arguments: '{"y":2}' } },
        ]);
        const calls = finalizeToolCalls(accs);
        expect(calls).toEqual([
            { id: 'call_1', name: 'a', arguments: '{"x":1}' },
            { id: 'call_2', name: 'b', arguments: '{"y":2}' },
        ]);
    });

    it('returns empty array when no deltas received', () => {
        const accs = new Map();
        expect(finalizeToolCalls(accs)).toEqual([]);
    });
});
