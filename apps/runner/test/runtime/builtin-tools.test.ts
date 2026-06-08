import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createBashTool,
    createCreateGraphTool,
    createEditFileTool,
    createEditGraphTool,
    createInstantiateCompositeTool,
    createListDirectoryTool,
    createMemoryReadTool,
    createMemoryWriteTool,
    createReadCanvasTool,
    createReadFileTool,
    createReadGraphTool,
    createWriteFileTool,
} from '../../src/runtime/builtin-tools.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import {
    createGraphRuntimeRegistry,
    createNodeRegistry,
    type GraphRuntimeRegistry,
} from '../../src/runtime/graph-runtime.js';
import { createInMemoryHandle, readMarkdownContent } from '../../src/runtime/memory.js';
import type { Graph } from '@fabritorio/types';

describe('read_file (workspace-bound)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-readfile-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('reads a file under the workspace root', async () => {
        writeFileSync(join(dir, 'note.txt'), 'hello workspace', 'utf8');
        const tool = createReadFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: 'note.txt' }, ctx);
        expect(r).toEqual({ stdout: 'hello workspace', stderr: '', exit_code: 0 });
    });

    it('rejects parent-traversal paths', async () => {
        const tool = createReadFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: '../etc/passwd' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/escapes workspace/);
    });

    it('rejects absolute paths outside the workspace root', async () => {
        const tool = createReadFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: '/etc/passwd' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/escapes workspace/);
    });

    it('rejects directories', async () => {
        mkdirSync(join(dir, 'sub'));
        const tool = createReadFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: 'sub' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/not a file/);
    });

    it('returns a stat error for missing files', async () => {
        const tool = createReadFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: 'missing.txt' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/stat failed/);
    });

    it('requires the path argument', async () => {
        const tool = createReadFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument/);
    });

    it('falls back to cwd when no Workspace is wired', async () => {
        writeFileSync(join(dir, 'fallback.txt'), 'fallback ok', 'utf8');
        const orig = process.cwd();
        try {
            process.chdir(dir);
            const tool = createReadFileTool(null);
            const r = await tool.handler({ path: 'fallback.txt' }, ctx);
            expect(r).toEqual({ stdout: 'fallback ok', stderr: '', exit_code: 0 });
        } finally {
            process.chdir(orig);
        }
    });
});

describe('write_file (workspace-bound)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-writefile-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('writes a new file under the workspace root', async () => {
        const tool = createWriteFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'out.txt', content: 'hello' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/wrote 5 bytes/);
        expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hello');
    });

    it('overwrites an existing file', async () => {
        writeFileSync(join(dir, 'out.txt'), 'old', 'utf8');
        const tool = createWriteFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'out.txt', content: 'new' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('new');
    });

    it('creates parent directories as needed', async () => {
        const tool = createWriteFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'nested/deep/note.txt', content: 'x' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(readFileSync(join(dir, 'nested/deep/note.txt'), 'utf8')).toBe('x');
    });

    it('rejects parent-traversal paths', async () => {
        const tool = createWriteFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: '../escape.txt', content: 'x' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/escapes workspace/);
    });

    it('refuses to overwrite a directory', async () => {
        mkdirSync(join(dir, 'sub'));
        const tool = createWriteFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'sub', content: 'x' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/target is a directory/);
    });

    it('refuses without read-write permissions', async () => {
        const tool = createWriteFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: 'out.txt', content: 'x' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/read-write/);
        expect(existsSync(join(dir, 'out.txt'))).toBe(false);
    });

    it('refuses without a wired Workspace', async () => {
        const tool = createWriteFileTool(null);
        const r = await tool.handler({ path: 'out.txt', content: 'x' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/requires a Workspace/);
    });

    it('requires the content argument', async () => {
        const tool = createWriteFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'out.txt' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument: content/);
    });
});

describe('edit_file (workspace-bound)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-editfile-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('replaces a unique snippet', async () => {
        writeFileSync(join(dir, 'f.txt'), 'alpha beta gamma', 'utf8');
        const tool = createEditFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'f.txt', old_text: 'beta', new_text: 'BETA' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('alpha BETA gamma');
    });

    it('errors when old_text is not present', async () => {
        writeFileSync(join(dir, 'f.txt'), 'alpha beta', 'utf8');
        const tool = createEditFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'f.txt', old_text: 'missing', new_text: 'x' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/not found/);
    });

    it('errors when old_text matches more than once', async () => {
        writeFileSync(join(dir, 'f.txt'), 'ab ab ab', 'utf8');
        const tool = createEditFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'f.txt', old_text: 'ab', new_text: 'X' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/matched 3 times/);
        expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('ab ab ab');
    });

    it('rejects empty old_text', async () => {
        writeFileSync(join(dir, 'f.txt'), 'x', 'utf8');
        const tool = createEditFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'f.txt', old_text: '', new_text: 'y' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/old_text must not be empty/);
    });

    it('errors when the file is missing', async () => {
        const tool = createEditFileTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ path: 'missing.txt', old_text: 'a', new_text: 'b' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/read failed/);
    });

    it('refuses without read-write permissions', async () => {
        writeFileSync(join(dir, 'f.txt'), 'alpha', 'utf8');
        const tool = createEditFileTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: 'f.txt', old_text: 'alpha', new_text: 'beta' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/read-write/);
        expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('alpha');
    });
});

describe('bash (workspace-bound)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-bash-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('runs a simple command and returns merged stdout/stderr', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'echo hello' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout.trim()).toBe('hello');
        expect(r.stderr).toBe('');
    });

    it('merges stderr into stdout in arrival order', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'echo out; echo err 1>&2' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/out/);
        expect(r.stdout).toMatch(/err/);
    });

    it('propagates non-zero exit codes', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'exit 7' }, ctx);
        expect(r.exit_code).toBe(7);
    });

    it('runs in the workspace root by default', async () => {
        writeFileSync(join(dir, 'marker.txt'), 'ok', 'utf8');
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'cat marker.txt' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout.trim()).toBe('ok');
    });

    it('accepts a relative cwd under the workspace', async () => {
        mkdirSync(join(dir, 'sub'));
        writeFileSync(join(dir, 'sub/marker.txt'), 'nested', 'utf8');
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'cat marker.txt', cwd: 'sub' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout.trim()).toBe('nested');
    });

    it('rejects an absolute cwd outside the workspace', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'ls', cwd: '/etc' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/escapes workspace/);
    });

    it('rejects a parent-traversal cwd', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'ls', cwd: '../' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/escapes workspace/);
    });

    it('times out long-running commands and returns exit_code 124', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'sleep 5', timeout_seconds: 1 }, ctx);
        expect(r.exit_code).toBe(124);
        expect(r.stdout).toMatch(/timed out after 1s/);
    }, 10000);

    it('truncates large output to the tail with a note', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler(
            { command: 'for i in $(seq 1 800); do echo line $i; done' },
            ctx,
        );
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/Output truncated: showing last 500 of 801 lines/);
        expect(r.stdout).toMatch(/line 800/);
        expect(r.stdout).not.toMatch(/^line 1$/m);
    });

    it('strips ANSI escape sequences from output', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: "printf '\\033[31mred\\033[0m\\n'" }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout.trim()).toBe('red');
    });

    it('requires a non-empty command', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: '   ' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument: command/);
    });

    it('refuses without a wired Workspace', async () => {
        const tool = createBashTool(null);
        const r = await tool.handler({ command: 'echo hi' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/requires a Workspace/);
    });

    it('refuses without read-write permissions', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ command: 'echo hi' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/read-write/);
    });

    it('caps absurdly large requested timeouts', async () => {
        const tool = createBashTool({ path: dir, permissions: 'read-write' });
        const r = await tool.handler({ command: 'echo ok', timeout_seconds: 999_999 }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout.trim()).toBe('ok');
    });
});

describe('list_directory (workspace-bound)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-listdir-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('lists files and directories at the workspace root', async () => {
        writeFileSync(join(dir, 'b.txt'), '1', 'utf8');
        writeFileSync(join(dir, 'a.txt'), '1', 'utf8');
        mkdirSync(join(dir, 'sub'));
        const tool = createListDirectoryTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout.split('\n')).toEqual(['a.txt', 'b.txt', 'sub/']);
    });

    it('lists a nested directory by relative path', async () => {
        mkdirSync(join(dir, 'sub'));
        writeFileSync(join(dir, 'sub/inside.txt'), '1', 'utf8');
        const tool = createListDirectoryTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: 'sub' }, ctx);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('inside.txt');
    });

    it('rejects parent-traversal paths', async () => {
        const tool = createListDirectoryTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: '..' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/escapes workspace/);
    });

    it('errors when the target is not a directory', async () => {
        writeFileSync(join(dir, 'f.txt'), '1', 'utf8');
        const tool = createListDirectoryTool({ path: dir, permissions: 'read' });
        const r = await tool.handler({ path: 'f.txt' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/not a directory/);
    });
});

describe('memory_read / memory_write (markdown-tool-bound)', () => {
    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('memory_read returns empty stdout for a fresh handle', async () => {
        const handle = createInMemoryHandle('sp-1');
        const tool = createMemoryReadTool(handle);
        const r = await tool.handler({}, ctx);
        expect(r).toEqual({ stdout: '', stderr: '', exit_code: 0 });
    });

    it('memory_write persists content the next memory_read returns it', async () => {
        const handle = createInMemoryHandle('sp-1');
        const writeTool = createMemoryWriteTool(handle);
        const readTool = createMemoryReadTool(handle);

        const w = await writeTool.handler({ content: '# notes\n- favorite editor: Helix' }, ctx);
        expect(w.exit_code).toBe(0);
        expect(w.stdout).toMatch(/wrote \d+ bytes/);
        expect(readMarkdownContent(handle)).toBe('# notes\n- favorite editor: Helix');

        const r = await readTool.handler({}, ctx);
        expect(r).toEqual({
            stdout: '# notes\n- favorite editor: Helix',
            stderr: '',
            exit_code: 0,
        });
    });

    it('memory_write fully replaces prior content (no merge / append)', async () => {
        const handle = createInMemoryHandle('sp-1');
        const tool = createMemoryWriteTool(handle);
        await tool.handler({ content: 'first' }, ctx);
        await tool.handler({ content: 'second' }, ctx);
        expect(readMarkdownContent(handle)).toBe('second');
    });

    it('memory_write rejects a missing content argument', async () => {
        const handle = createInMemoryHandle('sp-1');
        const tool = createMemoryWriteTool(handle);
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument: content/);
    });

    it('memory_read refuses cleanly when no tool memory is wired', async () => {
        const tool = createMemoryReadTool(null);
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/storage_kind="markdown"/);
    });

    it('memory_write refuses cleanly when no tool memory is wired', async () => {
        const tool = createMemoryWriteTool(null);
        const r = await tool.handler({ content: 'x' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/storage_kind="markdown"/);
    });
});

describe('read_graph (graph-store-bound)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-graphtools-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('read_graph returns the full Graph JSON for a known id', async () => {
        const store = createGraphStore({ dir });
        const saved = await store.create({
            kind: 'l1',
            name: 'agent',
            nodes: [],
            edges: [],
        });
        const tool = createReadGraphTool(store);
        const r = await tool.handler({ id: saved.id! }, ctx);
        expect(r.exit_code).toBe(0);
        const parsed = JSON.parse(r.stdout) as { id: string; kind: string; name?: string };
        expect(parsed.id).toBe(saved.id);
        expect(parsed.kind).toBe('l1');
        expect(parsed.name).toBe('agent');
    });

    it('read_graph errors cleanly for an unknown id', async () => {
        const store = createGraphStore({ dir });
        const tool = createReadGraphTool(store);
        const r = await tool.handler({ id: '00000000-0000-4000-8000-000000000099' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/graph not found/);
    });

    it('read_graph requires the id argument', async () => {
        const store = createGraphStore({ dir });
        const tool = createReadGraphTool(store);
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument: id/);
    });

    it('read_graph refuses cleanly when no GraphStore is wired', async () => {
        const read = createReadGraphTool(null);
        const rr = await read.handler({ id: '00000000-0000-4000-8000-000000000001' }, ctx);
        expect(rr.exit_code).toBe(1);
        expect(rr.stderr).toMatch(/GraphStore/);
    });
});

describe('read_canvas (anchor to active L2)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-canvas-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('returns the full L2 graph containing a NativeAgent that references this L1', async () => {
        const store = createGraphStore({ dir });
        const l1 = await store.create({ kind: 'l1', name: 'coder', nodes: [], edges: [] });
        const l2 = await store.create({
            kind: 'l2',
            name: 'main canvas',
            nodes: [
                {
                    id: 'agent-1',
                    type: 'native_agent',
                    position: { x: 0, y: 0 },
                    l1_graph_id: l1.id!,
                },
            ],
            edges: [],
        });
        await store.create({ kind: 'l2', name: 'someone-else', nodes: [], edges: [] });

        const tool = createReadCanvasTool(store, l1.id!);
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(0);
        const parsed = JSON.parse(r.stdout) as {
            id: string;
            kind: string;
            name?: string;
            nodes: Array<{ id: string; type: string }>;
        };
        expect(parsed.id).toBe(l2.id);
        expect(parsed.kind).toBe('l2');
        expect(parsed.name).toBe('main canvas');
        expect(parsed.nodes.find((n) => n.id === 'agent-1')?.type).toBe('native_agent');
    });

    it('errors with "no active canvas" when this L1 is not wired into any L2', async () => {
        const store = createGraphStore({ dir });
        const l1 = await store.create({ kind: 'l1', nodes: [], edges: [] });
        await store.create({ kind: 'l2', name: 'unrelated', nodes: [], edges: [] });

        const tool = createReadCanvasTool(store, l1.id!);
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/no active canvas/i);
    });

    it('refuses cleanly when no GraphStore is wired', async () => {
        const tool = createReadCanvasTool(null, 'some-id');
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/GraphStore/);
    });

    it('refuses cleanly when no L1 graph id is set (unsaved L1)', async () => {
        const store = createGraphStore({ dir });
        const tool = createReadCanvasTool(store, null);
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/no L1 graph id/i);
    });
});

function makeRuntimes(): GraphRuntimeRegistry {
    const bus = createEventBus();
    const nodes = createNodeRegistry();
    return createGraphRuntimeRegistry({ bus, nodes });
}

describe('create_graph (graph-store + runtimes)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-creategraph-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('persists a new graph and returns its id', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const tool = createCreateGraphTool(store, runtimes);
        const r = await tool.handler({ kind: 'l1', name: 'fresh' }, ctx);
        expect(r.exit_code).toBe(0);
        const parsed = JSON.parse(r.stdout) as { id: string; graph: Graph };
        expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/);
        const persisted = await store.get(parsed.id);
        expect(persisted?.kind).toBe('l1');
        expect(persisted?.name).toBe('fresh');
    });

    it('runs the draft through auto-layout before persisting', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const tool = createCreateGraphTool(store, runtimes);
        const r = await tool.handler(
            {
                kind: 'l1',
                nodes: [
                    { id: 'a', type: 'gateway', position: { x: 0, y: 0 } },
                    { id: 'b', type: 'handler', position: { x: 0, y: 0 }, max_iterations: 8 },
                ],
                edges: [
                    {
                        id: 'e1',
                        source: { node_id: 'a' },
                        target: { node_id: 'b' },
                    },
                ],
            },
            ctx,
        );
        expect(r.exit_code).toBe(0);
        const parsed = JSON.parse(r.stdout) as { graph: Graph };
        const byId = Object.fromEntries(parsed.graph.nodes.map((n) => [n.id, n.position]));
        expect(byId.a).toEqual({ x: 0, y: 0 });
        expect(byId.b).toEqual({ x: 240, y: 0 });
    });

    it('rejects invalid kind', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const tool = createCreateGraphTool(store, runtimes);
        const r = await tool.handler({ kind: 'banana' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/kind must be one of/);
    });

    it('rejects library: true (Foreman does not seed templates)', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const tool = createCreateGraphTool(store, runtimes);
        const r = await tool.handler({ kind: 'l1', library: true }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/library flag is not settable/);
    });

    it('refuses cleanly when GraphStore is not wired', async () => {
        const tool = createCreateGraphTool(null, makeRuntimes());
        const r = await tool.handler({ kind: 'l1' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/GraphStore/);
    });

    it('refuses cleanly when GraphRuntimeRegistry is not wired', async () => {
        const tool = createCreateGraphTool(createGraphStore({ dir }), null);
        const r = await tool.handler({ kind: 'l1' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/GraphStore/);
    });
});

describe('edit_graph (graph-store + runtimes)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-editgraph-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('replaces the contents of an existing graph', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const seeded = await store.create({
            kind: 'l1',
            name: 'before',
            nodes: [],
            edges: [],
        });
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler(
            {
                id: seeded.id!,
                graph: {
                    kind: 'l1',
                    name: 'after',
                    nodes: [],
                    edges: [],
                },
            },
            ctx,
        );
        expect(r.exit_code).toBe(0);
        const reloaded = await store.get(seeded.id!);
        expect(reloaded?.name).toBe('after');
    });

    it('runs the draft through auto-layout before persisting', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const seeded = await store.create({
            kind: 'l1',
            name: 'l1',
            nodes: [],
            edges: [],
        });
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler(
            {
                id: seeded.id!,
                graph: {
                    kind: 'l1',
                    nodes: [
                        { id: 'a', type: 'gateway', position: { x: 0, y: 0 } },
                        {
                            id: 'b',
                            type: 'handler',
                            position: { x: 0, y: 0 },
                            max_iterations: 8,
                        },
                    ],
                    edges: [
                        {
                            id: 'e1',
                            source: { node_id: 'a' },
                            target: { node_id: 'b' },
                        },
                    ],
                },
            },
            ctx,
        );
        expect(r.exit_code).toBe(0);
        const reloaded = await store.get(seeded.id!);
        const byId = Object.fromEntries((reloaded?.nodes ?? []).map((n) => [n.id, n.position]));
        expect(byId.a).toEqual({ x: 0, y: 0 });
        expect(byId.b).toEqual({ x: 240, y: 0 });
    });

    it('rejects mismatched kind', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const seeded = await store.create({ kind: 'l1', nodes: [], edges: [] });
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler(
            { id: seeded.id!, graph: { kind: 'l2', nodes: [], edges: [] } },
            ctx,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/does not match existing kind/);
    });

    it('rejects mismatched id inside payload', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const seeded = await store.create({ kind: 'l1', nodes: [], edges: [] });
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler(
            {
                id: seeded.id!,
                graph: {
                    id: '00000000-0000-4000-8000-000000000099',
                    kind: 'l1',
                    nodes: [],
                    edges: [],
                },
            },
            ctx,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/does not match target id/);
    });

    it('rejects library flag flip', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const seeded = await store.create({ kind: 'l1', nodes: [], edges: [] });
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler(
            {
                id: seeded.id!,
                graph: { kind: 'l1', library: true, nodes: [], edges: [] },
            },
            ctx,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/library flag is immutable/);
    });

    it('errors on unknown id', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler(
            {
                id: '00000000-0000-4000-8000-000000000099',
                graph: { kind: 'l1', nodes: [], edges: [] },
            },
            ctx,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/graph not found/);
    });

    it('rejects invalid id', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler(
            { id: 'not-a-uuid', graph: { kind: 'l1', nodes: [], edges: [] } },
            ctx,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/invalid graph id/);
    });

    it('requires the id argument', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler({ graph: { kind: 'l1', nodes: [], edges: [] } }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument: id/);
    });

    it('requires the graph object', async () => {
        const store = createGraphStore({ dir });
        const runtimes = makeRuntimes();
        const seeded = await store.create({ kind: 'l1', nodes: [], edges: [] });
        const tool = createEditGraphTool(store, runtimes);
        const r = await tool.handler({ id: seeded.id! }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/graph must be an object/);
    });

    it('refuses cleanly when GraphStore is not wired', async () => {
        const tool = createEditGraphTool(null, makeRuntimes());
        const r = await tool.handler(
            {
                id: '00000000-0000-4000-8000-000000000001',
                graph: { kind: 'l1', nodes: [], edges: [] },
            },
            ctx,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/GraphStore/);
    });

    it('refuses cleanly when GraphRuntimeRegistry is not wired', async () => {
        const tool = createEditGraphTool(createGraphStore({ dir }), null);
        const r = await tool.handler(
            {
                id: '00000000-0000-4000-8000-000000000001',
                graph: { kind: 'l1', nodes: [], edges: [] },
            },
            ctx,
        );
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/GraphStore/);
    });
});

describe('instantiate_composite (graph-store-bound)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-instantiate-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const ctx = { call_id: 'c1', eventId: 'ev-1' };

    it('stamps a library template into a fresh runtime graph and returns id + remap', async () => {
        const store = createGraphStore({ dir });
        const template = await store.create({
            kind: 'l1',
            name: 'tmpl',
            library: true,
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h',
                    type: 'handler',
                    position: { x: 240, y: 0 },
                    max_iterations: 8,
                },
            ],
            edges: [{ id: 'e1', source: { node_id: 'gw' }, target: { node_id: 'h' } }],
        });
        const tool = createInstantiateCompositeTool(store);
        const r = await tool.handler({ template_id: template.id! }, ctx);
        expect(r.exit_code).toBe(0);

        const parsed = JSON.parse(r.stdout) as { id: string; remap: Record<string, string> };
        expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(parsed.id).not.toBe(template.id);

        expect(parsed.remap[template.id!]).toBe(parsed.id);

        const copy = await store.get(parsed.id);
        expect(copy?.kind).toBe('l1');
        expect(copy?.library ?? false).toBe(false);
        expect(copy?.nodes).toHaveLength(2);
        const tmplReread = await store.get(template.id!);
        expect(tmplReread?.library).toBe(true);
    });

    it('refuses cleanly when the template id is unknown', async () => {
        const store = createGraphStore({ dir });
        const tool = createInstantiateCompositeTool(store);
        const r = await tool.handler({ template_id: '00000000-0000-4000-8000-000000000099' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/template not found/);
    });

    it('refuses cleanly when the referenced graph is not a library template', async () => {
        const store = createGraphStore({ dir });
        const runtime = await store.create({
            kind: 'l1',
            name: 'not-a-template',
            nodes: [],
            edges: [],
        });
        const tool = createInstantiateCompositeTool(store);
        const r = await tool.handler({ template_id: runtime.id! }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/not a library template/);
        const all = await store.list();
        expect(all).toHaveLength(1);
    });

    it('requires the template_id argument', async () => {
        const store = createGraphStore({ dir });
        const tool = createInstantiateCompositeTool(store);
        const r = await tool.handler({}, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/missing required argument: template_id/);
    });

    it('refuses cleanly when no GraphStore is wired', async () => {
        const tool = createInstantiateCompositeTool(null);
        const r = await tool.handler({ template_id: '00000000-0000-4000-8000-000000000001' }, ctx);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/GraphStore/);
    });
});
