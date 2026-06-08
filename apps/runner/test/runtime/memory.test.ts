import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryNode, Message } from '@fabritorio/types';
import {
    createFileBackedHandle,
    createInMemoryHandle,
    createMarkdownFileBackedHandle,
    createMemoryRegistry,
    estimateTokens,
    migrateMemoryNode,
    migrateMemoryNodesInGraph,
    partitionMemoryNodes,
    readMarkdownContent,
    renderInjectedMemoryBlock,
    windowMessagesByTokenBudget,
    windowMessagesByTurns,
    writeMarkdownContent,
} from '../../src/runtime/memory.js';
import { existsSync } from 'node:fs';

describe('createInMemoryHandle', () => {
    it('read/write/delete/snapshot round-trip', () => {
        const h = createInMemoryHandle('mem-1');
        expect(h.nodeId).toBe('mem-1');
        expect(h.read('k')).toBeUndefined();
        h.write('k', { v: 1 });
        expect(h.read('k')).toEqual({ v: 1 });
        h.write('k2', 'second');
        expect(h.snapshot()).toEqual({ k: { v: 1 }, k2: 'second' });
        h.delete('k');
        expect(h.read('k')).toBeUndefined();
        expect(h.snapshot()).toEqual({ k2: 'second' });
    });

    it('isolates state across handles with different node ids', () => {
        const a = createInMemoryHandle('a');
        const b = createInMemoryHandle('b');
        a.write('shared', 1);
        b.write('shared', 2);
        expect(a.read('shared')).toBe(1);
        expect(b.read('shared')).toBe(2);
    });
});

describe('createMemoryRegistry', () => {
    const baseNode: MemoryNode = {
        id: 'm',
        type: 'memory',
        storage: 'in_memory',
        storage_kind: 'kv',
        handling: 'full_history',
        tool_access: 'none',
        position: { x: 0, y: 0 },
    };

    it('resolve materialises the handle on first call and caches it thereafter', () => {
        const reg = createMemoryRegistry();
        const first = reg.resolve(baseNode);
        expect(first.nodeId).toBe('m');
        expect(reg.resolve(baseNode)).toBe(first);
        expect(reg.get('m')).toBe(first);
        expect(reg.list()).toEqual([first]);
    });

    it('resolve honours the node storage config', () => {
        const reg = createMemoryRegistry();
        const inMem = reg.resolve({ ...baseNode, id: 'in' });
        inMem.write('k', 1);
        expect(inMem.read('k')).toBe(1);
    });

    it('re-materialises the handle when the storage backend signature drifts', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fabritorio-memory-drift-'));
        try {
            const reg = createMemoryRegistry({ localStorageDir: dir });
            const markdownNode: MemoryNode = {
                ...baseNode,
                id: 'drift',
                storage: 'local_storage',
                storage_kind: 'markdown',
                handling: 'always_inject',
                tool_access: 'read_write',
            };
            const md = reg.resolve(markdownNode);
            expect(() => md.write('chat:agent-x:conv-y', [])).toThrow(/only "content" is writable/);

            const kvNode: MemoryNode = {
                ...baseNode,
                id: 'drift',
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'full_history',
            };
            const kv = reg.resolve(kvNode);
            expect(kv).not.toBe(md);
            expect(() =>
                kv.write('chat:agent-x:conv-y', [{ role: 'user', content: 'hi' }]),
            ).not.toThrow();
            expect(kv.read('chat:agent-x:conv-y')).toEqual([{ role: 'user', content: 'hi' }]);
            expect(reg.get('drift')).toBe(kv);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('resolve throws on an unsupported storage kind', () => {
        const reg = createMemoryRegistry();
        expect(() =>
            reg.resolve({
                ...baseNode,
                id: 'x',
                storage: 'wat',
            } as unknown as Parameters<typeof reg.resolve>[0]),
        ).toThrow(/unsupported storage/);
    });
});

describe('createFileBackedHandle', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-memory-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('read/write/delete/snapshot mirror in-memory semantics', () => {
        const h = createFileBackedHandle('mem-1', dir);
        expect(h.read('k')).toBeUndefined();
        h.write('k', { v: 1 });
        h.write('k2', 'second');
        expect(h.read('k')).toEqual({ v: 1 });
        expect(h.snapshot()).toEqual({ k: { v: 1 }, k2: 'second' });
        h.delete('k');
        expect(h.snapshot()).toEqual({ k2: 'second' });
    });

    it('persists writes to <nodeId>.json and a fresh handle reloads them', () => {
        const a = createFileBackedHandle('session-7', dir);
        a.write('history', [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ]);

        const onDisk = JSON.parse(readFileSync(join(dir, 'session-7.json'), 'utf8'));
        expect(onDisk).toEqual({
            history: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello' },
            ],
        });

        const b = createFileBackedHandle('session-7', dir);
        expect(b.read('history')).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ]);
        b.delete('history');

        const c = createFileBackedHandle('session-7', dir);
        expect(c.read('history')).toBeUndefined();
    });

    it('isolates state per nodeId in the same dir', () => {
        const a = createFileBackedHandle('a', dir);
        const b = createFileBackedHandle('b', dir);
        a.write('x', 1);
        b.write('x', 2);
        expect(a.read('x')).toBe(1);
        expect(b.read('x')).toBe(2);
        const a2 = createFileBackedHandle('a', dir);
        const b2 = createFileBackedHandle('b', dir);
        expect(a2.read('x')).toBe(1);
        expect(b2.read('x')).toBe(2);
    });

    it('starts empty when an existing file is corrupt JSON', () => {
        writeFileSync(join(dir, 'bad.json'), '{ not json', 'utf8');
        const h = createFileBackedHandle('bad', dir);
        expect(h.snapshot()).toEqual({});
        h.write('k', 1);
        const h2 = createFileBackedHandle('bad', dir);
        expect(h2.read('k')).toBe(1);
    });
});

const memNode = (
    id: string,
    cfg: {
        storage_kind?: MemoryNode['storage_kind'];
        handling?: MemoryNode['handling'];
        tool_access?: MemoryNode['tool_access'];
        content?: string;
    } = {},
): MemoryNode => ({
    id,
    type: 'memory',
    storage: 'in_memory',
    storage_kind: cfg.storage_kind ?? 'kv',
    handling: cfg.handling ?? 'full_history',
    tool_access: cfg.tool_access ?? 'none',
    position: { x: 0, y: 0 },
    ...(cfg.content !== undefined ? { content: cfg.content } : {}),
});

describe('migrateMemoryNode', () => {
    it('rewrites legacy "session" purpose into kv + full_history + none', () => {
        const legacy = {
            id: 's',
            type: 'memory' as const,
            storage: 'in_memory' as const,
            position: { x: 0, y: 0 },
            purpose: 'session',
        } as unknown as MemoryNode;
        const { node, migrated } = migrateMemoryNode(legacy);
        expect(migrated).toBe(true);
        expect(node.storage_kind).toBe('kv');
        expect(node.handling).toBe('full_history');
        expect(node.tool_access).toBe('none');
        expect((node as { purpose?: unknown }).purpose).toBeUndefined();
    });

    it('rewrites legacy "context" purpose into static_string + always_inject + none', () => {
        const legacy = {
            id: 'c',
            type: 'memory' as const,
            storage: 'in_memory' as const,
            position: { x: 0, y: 0 },
            purpose: 'context',
            content: 'persona',
        } as unknown as MemoryNode;
        const { node, migrated } = migrateMemoryNode(legacy);
        expect(migrated).toBe(true);
        expect(node.storage_kind).toBe('static_string');
        expect(node.handling).toBe('always_inject');
        expect(node.tool_access).toBe('none');
        expect(node.content).toBe('persona');
    });

    it('rewrites legacy "scratchpad" purpose into markdown + always_inject + read_write', () => {
        const legacy = {
            id: 'sp',
            type: 'memory' as const,
            storage: 'local_storage' as const,
            position: { x: 0, y: 0 },
            purpose: 'scratchpad',
        } as unknown as MemoryNode;
        const { node, migrated } = migrateMemoryNode(legacy);
        expect(migrated).toBe(true);
        expect(node.storage_kind).toBe('markdown');
        expect(node.handling).toBe('always_inject');
        expect(node.tool_access).toBe('read_write');
    });

    it('treats a missing purpose (legacy default) as "session"', () => {
        const legacy = {
            id: 'd',
            type: 'memory' as const,
            storage: 'in_memory' as const,
            position: { x: 0, y: 0 },
        } as unknown as MemoryNode;
        const { node, migrated } = migrateMemoryNode(legacy);
        expect(migrated).toBe(true);
        expect(node.storage_kind).toBe('kv');
        expect(node.handling).toBe('full_history');
        expect(node.tool_access).toBe('none');
    });

    it('passes already-migrated nodes through unchanged', () => {
        const fresh = memNode('m');
        const { node, migrated } = migrateMemoryNode(fresh);
        expect(migrated).toBe(false);
        expect(node).toBe(fresh);
    });
});

describe('migrateMemoryNodesInGraph', () => {
    it('rewrites every Memory node in a graph; non-memory nodes pass through', () => {
        const graph = {
            kind: 'l2' as const,
            nodes: [
                {
                    id: 's',
                    type: 'memory',
                    storage: 'in_memory',
                    position: { x: 0, y: 0 },
                    purpose: 'session',
                },
                {
                    id: 'c',
                    type: 'memory',
                    storage: 'in_memory',
                    position: { x: 0, y: 0 },
                    purpose: 'context',
                    content: 'hi',
                },
                { id: 'ch', type: 'channel', channel_kind: 'webchat', position: { x: 0, y: 0 } },
            ],
            edges: [],
        } as unknown as Parameters<typeof migrateMemoryNodesInGraph>[0];
        const out = migrateMemoryNodesInGraph(graph);
        expect(out).not.toBe(graph);
        const session = out.nodes[0] as MemoryNode;
        expect(session.handling).toBe('full_history');
        const ctx = out.nodes[1] as MemoryNode;
        expect(ctx.storage_kind).toBe('static_string');
        expect(out.nodes[2]).toBe(graph.nodes[2]);
    });

    it('returns the same graph identity when no Memory nodes need migration', () => {
        const graph = {
            kind: 'l2' as const,
            nodes: [memNode('m')],
            edges: [],
        } as unknown as Parameters<typeof migrateMemoryNodesInGraph>[0];
        const out = migrateMemoryNodesInGraph(graph);
        expect(out).toBe(graph);
    });
});

describe('partitionMemoryNodes', () => {
    it('routes the three legacy mappings into the right buckets', () => {
        const session = memNode('s', { storage_kind: 'kv', handling: 'full_history' });
        const ctx1 = memNode('c1', {
            storage_kind: 'static_string',
            handling: 'always_inject',
            content: 'a',
        });
        const ctx2 = memNode('c2', {
            storage_kind: 'static_string',
            handling: 'always_inject',
            content: 'b',
        });
        const scratch = memNode('sp', {
            storage_kind: 'markdown',
            handling: 'always_inject',
            tool_access: 'read_write',
        });

        const result = partitionMemoryNodes([session, ctx1, ctx2, scratch]);

        expect(result.historyMemory).toBe(session);
        expect(result.injectedMemories).toEqual([ctx1, ctx2, scratch]);
        expect(result.toolMemory).toBe(scratch);
    });

    it('takes the first when multiple history memories are wired (footgun warning territory)', () => {
        const a = memNode('a', { handling: 'full_history' });
        const b = memNode('b', { handling: 'full_history' });
        const result = partitionMemoryNodes([a, b]);
        expect(result.historyMemory).toBe(a);
    });

    it('routes last_n into historyMemory alongside full_history', () => {
        const lastN = memNode('ln', { handling: 'last_n' });
        const result = partitionMemoryNodes([lastN]);
        expect(result.historyMemory).toBe(lastN);
    });

    it('routes last_within_tokens into historyMemory alongside full_history', () => {
        const lastTokens = memNode('lt', { handling: 'last_within_tokens' });
        const result = partitionMemoryNodes([lastTokens]);
        expect(result.historyMemory).toBe(lastTokens);
    });

    it('skips kv-storage memories when looking for tool access (must be markdown)', () => {
        const kvWithTool = memNode('k', { storage_kind: 'kv', tool_access: 'read_write' });
        const result = partitionMemoryNodes([kvWithTool]);
        expect(result.toolMemory).toBeUndefined();
    });
});

describe('markdown content helpers', () => {
    it('round-trips markdown through a handle under the "content" key', () => {
        const h = createInMemoryHandle('sp');
        expect(readMarkdownContent(h)).toBe('');
        writeMarkdownContent(h, '# notes\n- favorite editor: Helix');
        expect(readMarkdownContent(h)).toBe('# notes\n- favorite editor: Helix');
        expect(h.snapshot()).toEqual({ content: '# notes\n- favorite editor: Helix' });
    });

    it('returns empty string when the handle was never written', () => {
        const h = createInMemoryHandle('sp');
        expect(readMarkdownContent(h)).toBe('');
    });

    it('returns empty string when the stored value is non-string (corrupt restore)', () => {
        const h = createInMemoryHandle('sp');
        h.write('content', { not: 'a string' });
        expect(readMarkdownContent(h)).toBe('');
    });
});

describe('renderInjectedMemoryBlock', () => {
    it('returns empty when no memories contribute', () => {
        expect(renderInjectedMemoryBlock([], () => undefined)).toBe('');
    });

    it('renders static_string content directly', () => {
        const ctx = memNode('c', {
            storage_kind: 'static_string',
            handling: 'always_inject',
            content: 'persona text',
        });
        expect(renderInjectedMemoryBlock([ctx], () => undefined)).toBe('persona text');
    });

    it('renders markdown via the resolved handle, with the editable label when tool access is set', () => {
        const handle = createInMemoryHandle('sp');
        writeMarkdownContent(handle, 'favorite editor: Helix');
        const sp = memNode('sp', {
            storage_kind: 'markdown',
            handling: 'always_inject',
            tool_access: 'read_write',
        });
        const block = renderInjectedMemoryBlock([sp], () => handle);
        expect(block).toContain('## Scratchpad (editable via memory_read / memory_write)');
        expect(block).toContain('favorite editor: Helix');
    });

    it('renders markdown plainly when tool_access is none', () => {
        const handle = createInMemoryHandle('m');
        writeMarkdownContent(handle, 'static notes');
        const md = memNode('m', {
            storage_kind: 'markdown',
            handling: 'always_inject',
            tool_access: 'none',
        });
        const block = renderInjectedMemoryBlock([md], () => handle);
        expect(block).toBe('static notes');
    });

    it('skips empty contributions and joins multiple sections by blank lines', () => {
        const a = memNode('a', {
            storage_kind: 'static_string',
            handling: 'always_inject',
            content: 'first',
        });
        const empty = memNode('e', {
            storage_kind: 'static_string',
            handling: 'always_inject',
            content: '   ',
        });
        const b = memNode('b', {
            storage_kind: 'static_string',
            handling: 'always_inject',
            content: 'second',
        });
        const block = renderInjectedMemoryBlock([a, empty, b], () => undefined);
        expect(block).toBe('first\n\nsecond');
    });

    it('ignores memories whose handling is not always_inject', () => {
        const sess = memNode('s', { storage_kind: 'kv', handling: 'full_history' });
        expect(renderInjectedMemoryBlock([sess], () => undefined)).toBe('');
    });
});

describe('createMarkdownFileBackedHandle', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-md-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes raw markdown to <nodeId>.md (no JSON wrapping)', () => {
        const h = createMarkdownFileBackedHandle('sp', dir);
        h.write('content', '# notes\n\n- favorite editor: Helix\n```ts\nconst x = 1;\n```');

        const path = join(dir, 'sp.md');
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, 'utf8')).toBe(
            '# notes\n\n- favorite editor: Helix\n```ts\nconst x = 1;\n```',
        );
    });

    it('read("content") returns the file contents; other keys return undefined', () => {
        const h = createMarkdownFileBackedHandle('sp', dir);
        expect(h.read('content')).toBeUndefined();
        h.write('content', 'hello');
        expect(h.read('content')).toBe('hello');
        expect(h.read('other')).toBeUndefined();
    });

    it('reload sees prior writes (content survives a fresh handle)', () => {
        const a = createMarkdownFileBackedHandle('sp', dir);
        a.write('content', 'first');
        const b = createMarkdownFileBackedHandle('sp', dir);
        expect(b.read('content')).toBe('first');
    });

    it('delete("content") removes the file', () => {
        const h = createMarkdownFileBackedHandle('sp', dir);
        h.write('content', 'x');
        expect(existsSync(join(dir, 'sp.md'))).toBe(true);
        h.delete('content');
        expect(existsSync(join(dir, 'sp.md'))).toBe(false);
        expect(h.read('content')).toBeUndefined();
    });

    it('rejects writes to keys other than "content"', () => {
        const h = createMarkdownFileBackedHandle('sp', dir);
        expect(() => h.write('foo', 'x')).toThrow(/only "content" is writable/);
        expect(() => h.delete('foo')).toThrow(/only "content" is deletable/);
    });

    it('rejects non-string content', () => {
        const h = createMarkdownFileBackedHandle('sp', dir);
        expect(() => h.write('content', { not: 'a string' })).toThrow(/must be a string/);
    });

    it('snapshot returns { content } when set, {} when missing', () => {
        const h = createMarkdownFileBackedHandle('sp', dir);
        expect(h.snapshot()).toEqual({});
        h.write('content', 'x');
        expect(h.snapshot()).toEqual({ content: 'x' });
    });
});

describe('createMemoryRegistry routing', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-route-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('markdown + local_storage uses the .md handle (not JSON)', () => {
        const reg = createMemoryRegistry({ localStorageDir: dir });
        const handle = reg.resolve({
            id: 'sp-1',
            type: 'memory',
            storage: 'local_storage',
            storage_kind: 'markdown',
            handling: 'always_inject',
            tool_access: 'read_write',
            position: { x: 0, y: 0 },
        });
        handle.write('content', '# title\n\nbody');
        expect(existsSync(join(dir, 'sp-1.md'))).toBe(true);
        expect(existsSync(join(dir, 'sp-1.json'))).toBe(false);
    });

    it('kv + local_storage stays on the JSON handle', () => {
        const reg = createMemoryRegistry({ localStorageDir: dir });
        const handle = reg.resolve({
            id: 'sess-1',
            type: 'memory',
            storage: 'local_storage',
            storage_kind: 'kv',
            handling: 'full_history',
            tool_access: 'none',
            position: { x: 0, y: 0 },
        });
        handle.write('webchat:channel-1', [{ role: 'user', content: 'hi' }]);
        expect(existsSync(join(dir, 'sess-1.json'))).toBe(true);
        expect(existsSync(join(dir, 'sess-1.md'))).toBe(false);
    });
});

describe('windowMessagesByTurns', () => {
    const userAssistantPair = (i: number): Message[] => [
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
    ];

    it('returns empty when n <= 0', () => {
        expect(windowMessagesByTurns(userAssistantPair(1), 0)).toEqual([]);
        expect(windowMessagesByTurns(userAssistantPair(1), -3)).toEqual([]);
    });

    it('returns the full input when fewer turns than n exist', () => {
        const msgs = [...userAssistantPair(1), ...userAssistantPair(2)];
        expect(windowMessagesByTurns(msgs, 5)).toEqual(msgs);
    });

    it('keeps only the last n user/assistant turns', () => {
        const msgs = [
            ...userAssistantPair(1),
            ...userAssistantPair(2),
            ...userAssistantPair(3),
            ...userAssistantPair(4),
            ...userAssistantPair(5),
        ];
        const out = windowMessagesByTurns(msgs, 2);
        expect(out).toEqual([
            { role: 'user', content: 'u4' },
            { role: 'assistant', content: 'a4' },
            { role: 'user', content: 'u5' },
            { role: 'assistant', content: 'a5' },
        ]);
    });

    it('rides tool messages along with their parent turn', () => {
        const msgs: Message[] = [
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'x', arguments: {} }] },
            { role: 'tool', content: 'tool result', tool_call_id: 't' },
            { role: 'assistant', content: 'a2' },
        ];
        const out = windowMessagesByTurns(msgs, 1);
        expect(out).toEqual([
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'x', arguments: {} }] },
            { role: 'tool', content: 'tool result', tool_call_id: 't' },
            { role: 'assistant', content: 'a2' },
        ]);
    });

    it('handles a trailing in-flight user with no assistant reply yet', () => {
        const msgs: Message[] = [
            ...userAssistantPair(1),
            ...userAssistantPair(2),
            { role: 'user', content: 'u3-in-flight' },
        ];
        const out = windowMessagesByTurns(msgs, 1);
        expect(out).toEqual([{ role: 'user', content: 'u3-in-flight' }]);
    });
});

describe('estimateTokens', () => {
    it('chars/4 plus per-message overhead for a known string', () => {
        const t = estimateTokens({ role: 'user', content: 'hello world' });
        expect(t).toBe(8);
    });

    it('empty content yields just the per-message overhead (plus role chars)', () => {
        const t = estimateTokens({ role: 'user', content: '' });
        expect(t).toBe(5);
    });

    it('counts tool_calls arguments and ids', () => {
        const m: Message = {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 't1', name: 'do_thing', arguments: { x: 'y' } }],
        };
        const t = estimateTokens(m);
        expect(t).toBe(Math.ceil(28 / 4) + 4);
    });
});

describe('windowMessagesByTokenBudget', () => {
    const userAssistantPair = (i: number): Message[] => [
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
    ];

    it('returns the full input when budget exceeds total', () => {
        const msgs = [...userAssistantPair(1), ...userAssistantPair(2)];
        expect(windowMessagesByTokenBudget(msgs, 10_000)).toEqual(msgs);
    });

    it('returns empty when input is empty', () => {
        expect(windowMessagesByTokenBudget([], 100)).toEqual([]);
    });

    it('keeps the most recent turn even when budget cannot fit it', () => {
        const msgs: Message[] = [
            ...userAssistantPair(1),
            ...userAssistantPair(2),
            { role: 'user', content: 'u3-very-long-content-that-busts-budget' },
        ];
        const out = windowMessagesByTokenBudget(msgs, 1);
        expect(out).toEqual([{ role: 'user', content: 'u3-very-long-content-that-busts-budget' }]);
    });

    it('budget=0 still returns the most recent turn (defensible behavior)', () => {
        const msgs = [...userAssistantPair(1), ...userAssistantPair(2)];
        const out = windowMessagesByTokenBudget(msgs, 0);
        expect(out).toEqual([
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: 'a2' },
        ]);
    });

    it('walks back to the right boundary mid-history', () => {
        const msgs = [
            ...userAssistantPair(1),
            ...userAssistantPair(2),
            ...userAssistantPair(3),
            ...userAssistantPair(4),
        ];
        const out = windowMessagesByTokenBudget(msgs, 30);
        expect(out).toEqual([...userAssistantPair(3), ...userAssistantPair(4)]);
    });

    it('rides tool messages along with their parent turn', () => {
        const msgs: Message[] = [
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'x', arguments: {} }] },
            { role: 'tool', content: 'tool result', tool_call_id: 't' },
            { role: 'assistant', content: 'a2' },
        ];
        const out = windowMessagesByTokenBudget(msgs, 35);
        expect(out).toEqual([
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'x', arguments: {} }] },
            { role: 'tool', content: 'tool result', tool_call_id: 't' },
            { role: 'assistant', content: 'a2' },
        ]);
    });

    it('uses the injected estimator when provided', () => {
        const msgs = [...userAssistantPair(1), ...userAssistantPair(2)];
        const constant = () => 10;
        const out = windowMessagesByTokenBudget(msgs, 25, constant);
        expect(out).toEqual([
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: 'a2' },
        ]);
    });
});
