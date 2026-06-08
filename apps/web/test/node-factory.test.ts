import { describe, it, expect } from 'vitest';
import { buildNode, buildSavedRefNode } from '../lib/node-factory';

describe('buildNode', () => {
    it('creates a model with the required fields blank', () => {
        const n = buildNode('model', { x: 0, y: 0 });
        expect(n.type).toBe('model');
        if (n.type !== 'model') throw new Error('unreachable');
        expect(n.id).toMatch(/^model-/);
        expect(n.provider).toBe('');
        expect(n.model_id).toBe('');
        expect(n.temperature).toBeUndefined();
    });

    it('creates a gateway with no extra fields', () => {
        const n = buildNode('gateway', { x: 0, y: 0 });
        if (n.type !== 'gateway') throw new Error('unreachable');
        expect(n.id).toMatch(/^gateway-/);
    });

    it('creates an output node', () => {
        const n = buildNode('output', { x: 0, y: 0 });
        if (n.type !== 'output') throw new Error('unreachable');
        expect(n.id).toMatch(/^output-/);
    });

    it('creates a skill with an empty name', () => {
        const n = buildNode('skill', { x: 0, y: 0 });
        if (n.type !== 'skill') throw new Error('unreachable');
        expect(n.id).toMatch(/^skill-/);
        expect(n.name).toBe('');
    });

    it('creates a handler with handler-<token> id', () => {
        const n = buildNode('handler', { x: 0, y: 0 });
        if (n.type !== 'handler') throw new Error('unreachable');
        expect(n.id).toMatch(/^handler-/);
    });

    it('creates a tool node with empty tool_name', () => {
        const n = buildNode('tool', { x: 0, y: 0 });
        if (n.type !== 'tool') throw new Error('unreachable');
        expect(n.id).toMatch(/^tool-/);
        expect(n.tool_name).toBe('');
    });

    it('creates a tool_pack with pack-<token> id', () => {
        const n = buildNode('tool_pack', { x: 0, y: 0 });
        if (n.type !== 'tool_pack') throw new Error('unreachable');
        expect(n.id).toMatch(/^pack-/);
        expect(n.pack_name).toBeUndefined();
        expect(n.ref_id).toBeUndefined();
    });

    it('creates a bare skill_pack with no ref_id', () => {
        const n = buildNode('skill_pack', { x: 0, y: 0 });
        if (n.type !== 'skill_pack') throw new Error('unreachable');
        expect(n.id.length).toBeGreaterThan(0);
        expect(n.pack_name).toBeUndefined();
        expect(n.ref_id).toBeUndefined();
    });

    it('creates a workspace with read-write default', () => {
        const n = buildNode('workspace', { x: 0, y: 0 });
        if (n.type !== 'workspace') throw new Error('unreachable');
        expect(n.permissions).toBe('read-write');
    });

    it('creates an L2 channel with webchat default', () => {
        const n = buildNode('channel', { x: 0, y: 0 });
        if (n.type !== 'channel') throw new Error('unreachable');
        expect(n.channel_kind).toBe('webchat');
    });

    it('creates an L2 trigger defaulting to cron with a valid expression', () => {
        const n = buildNode('trigger', { x: 0, y: 0 });
        if (n.type !== 'trigger') throw new Error('unreachable');
        expect(n.trigger_kind).toBe('cron');
        expect(n.expression).toBe('*/5 * * * *');
    });

    it('creates an L2 schedule trigger with a PT15M interval recurrence default', () => {
        const n = buildNode('schedule', { x: 0, y: 0 });
        expect(n.type).toBe('trigger');
        if (n.type !== 'trigger') throw new Error('unreachable');
        expect(n.trigger_kind).toBe('schedule');
        expect(n.recurrence).toEqual({ kind: 'interval', every: 'PT15M' });
    });

    it('creates a bare native_agent with empty l1_graph_id', () => {
        const n = buildNode('native_agent', { x: 0, y: 0 });
        if (n.type !== 'native_agent') throw new Error('unreachable');
        expect(n.l1_graph_id).toBe('');
    });

    it('creates a cli_agent with go-claude defaults', () => {
        const n = buildNode('cli_agent', { x: 0, y: 0 });
        if (n.type !== 'cli_agent') throw new Error('unreachable');
        expect(n.command).toBe('go-claude');
        expect(n.session_mode).toBe('session-aware');
    });

    it('creates a pi_agent in session-aware mode with no command override', () => {
        const n = buildNode('pi_agent', { x: 0, y: 0 });
        if (n.type !== 'pi_agent') throw new Error('unreachable');
        expect(n.session_mode).toBe('session-aware');
        expect(n.command).toBeUndefined();
        expect(n.provider).toBeUndefined();
        expect(n.model).toBeUndefined();
    });

    it('creates a memory node with in-memory storage', () => {
        const n = buildNode('memory', { x: 0, y: 0 });
        if (n.type !== 'memory') throw new Error('unreachable');
        expect(n.storage).toBe('in_memory');
    });

    it('defaults a memory node to last_n; `n` is BE-stamped server-side', () => {
        const n = buildNode('memory', { x: 0, y: 0 });
        if (n.type !== 'memory') throw new Error('unreachable');
        expect(n.storage_kind).toBe('kv');
        expect(n.handling).toBe('last_n');
        expect(n.tool_access).toBe('none');
        expect(n.n).toBeUndefined();
    });

    it('creates a debug_probe; haltOn / enabled stamped server-side', () => {
        const n = buildNode('debug_probe', { x: 0, y: 0 });
        if (n.type !== 'debug_probe') throw new Error('unreachable');
        expect(n.id).toMatch(/^probe-/);
        expect(n.haltOn).toBeUndefined();
        expect(n.enabled).toBeUndefined();
        expect(n.attachedTo).toBeUndefined();
    });

    it('mints distinct ids on consecutive calls', () => {
        const first = buildNode('skill', { x: 0, y: 0 });
        const second = buildNode('skill', { x: 0, y: 0 });
        expect(first.id).not.toBe(second.id);
        expect(first.id).toMatch(/^skill-/);
        expect(second.id).toMatch(/^skill-/);
    });
});

describe('buildSavedRefNode', () => {
    it('synthesizes a tool_pack node with ref_id and pack_name', () => {
        const n = buildSavedRefNode('toolpack', 'graph-abc', 'My Tools', { x: 10, y: 20 });
        if (n.type !== 'tool_pack') throw new Error('unreachable');
        expect(n.id).toMatch(/^pack-/);
        expect(n.ref_id).toBe('graph-abc');
        expect(n.pack_name).toBe('My Tools');
        expect(n.position).toEqual({ x: 10, y: 20 });
    });

    it('synthesizes a skill_pack node with ref_id and pack_name', () => {
        const n = buildSavedRefNode('skillpack', 'graph-xyz', 'My Skills', { x: 0, y: 0 });
        if (n.type !== 'skill_pack') throw new Error('unreachable');
        expect(n.id).toMatch(/^skill-pack-/);
        expect(n.ref_id).toBe('graph-xyz');
        expect(n.pack_name).toBe('My Skills');
    });

    it('synthesizes a handler node with ref_id and undefined name', () => {
        const n = buildSavedRefNode('handler', 'graph-h', 'My Handler', { x: 0, y: 0 });
        if (n.type !== 'handler') throw new Error('unreachable');
        expect(n.id).toMatch(/^handler-/);
        expect(n.ref_id).toBe('graph-h');
        expect(n.name).toBeUndefined();
        expect(n.max_iterations).toBeUndefined();
    });

    it('synthesizes a native_agent node with l1_graph_id and display_name', () => {
        const n = buildSavedRefNode('l1', 'graph-l1', 'Coder Agent', { x: 5, y: 5 });
        if (n.type !== 'native_agent') throw new Error('unreachable');
        expect(n.id).toMatch(/^agent-/);
        expect(n.l1_graph_id).toBe('graph-l1');
        expect(n.display_name).toBe('Coder Agent');
    });

    it('copies the L1 graph description onto the dropped native_agent node', () => {
        const n = buildSavedRefNode(
            'l1',
            'graph-l1',
            'Tool builder agent',
            { x: 0, y: 0 },
            'tmpl-id',
            'Builds a runtime tool from an integration brief.',
        );
        if (n.type !== 'native_agent') throw new Error('unreachable');
        expect(n.description).toBe('Builds a runtime tool from an integration brief.');
    });

    it('leaves node description undefined when the L1 description is empty/whitespace', () => {
        const n = buildSavedRefNode(
            'l1',
            'graph-l1',
            'Starter agent',
            { x: 0, y: 0 },
            undefined,
            '  ',
        );
        if (n.type !== 'native_agent') throw new Error('unreachable');
        expect(n.description).toBeUndefined();
    });

    it('falls back to undefined pack_name when saved name is empty/whitespace', () => {
        const n = buildSavedRefNode('toolpack', 'graph-1', '   ', { x: 0, y: 0 });
        if (n.type !== 'tool_pack') throw new Error('unreachable');
        expect(n.pack_name).toBeUndefined();
        expect(n.ref_id).toBe('graph-1');
    });

    it('mints distinct ids on consecutive calls', () => {
        const first = buildSavedRefNode('toolpack', 'g1', 'A', { x: 0, y: 0 });
        const second = buildSavedRefNode('toolpack', 'g2', 'B', { x: 0, y: 0 });
        expect(first.id).not.toBe(second.id);
        expect(first.id).toMatch(/^pack-/);
        expect(second.id).toMatch(/^pack-/);
    });
});
