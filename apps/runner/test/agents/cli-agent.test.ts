import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import { createMemoryRegistry } from '../../src/runtime/memory.js';
import type { CliExecRequest, CliExecResult, CliExecutor } from '../../src/runtime/cli-executor.js';
import { inject } from '../helpers/inject.js';

interface MockExec {
    executor: CliExecutor;
    calls: CliExecRequest[];
}

function mockExecutor(replies: CliExecResult[]): MockExec {
    const calls: CliExecRequest[] = [];
    let i = 0;
    const executor: CliExecutor = async (req) => {
        calls.push(req);
        const reply = replies[i++];
        if (!reply) throw new Error('mock executor exhausted');
        return reply;
    };
    return { executor, calls };
}

interface CliDemoIds {
    l2Id: string;
    channelId: string;
    agentId: string;
    memoryId: string;
}

async function setupCliDemo(args: {
    graphsDir: string;
    workspaceDir?: string;
    withMemory?: boolean;
    executor: CliExecutor;
    extraNodes?: Graph['nodes'];
    extraEdges?: Graph['edges'];
}): Promise<{
    app: ReturnType<typeof buildServer>;
    channels: ReturnType<typeof createChannelRegistry>;
    memoryRegistry: ReturnType<typeof createMemoryRegistry>;
    ids: CliDemoIds;
}> {
    const graphStore = createGraphStore({ dir: args.graphsDir });
    const channels = createChannelRegistry();
    const memoryRegistry = createMemoryRegistry();

    const channelId = 'ch-cli';
    const agentId = 'ag-cli';
    const memoryId = 'mem-cli';
    const wsId = 'ws-cli';

    const baseNodes: Graph['nodes'] = [
        {
            id: channelId,
            type: 'channel',
            channel_kind: 'webchat',
            position: { x: 0, y: 0 },
        },
        {
            id: agentId,
            type: 'cli_agent',
            command: 'go-claude',
            session_mode: 'session-aware',
            output_format: 'text',
            position: { x: 200, y: 0 },
        },
    ];
    const baseEdges: Graph['edges'] = [
        {
            id: 'ch->ag',
            source: { node_id: channelId, port_id: 'out' },
            target: { node_id: agentId, port_id: 'in' },
        },
        {
            id: 'ag->ch',
            source: { node_id: agentId, port_id: 'out' },
            target: { node_id: channelId, port_id: 'in' },
        },
    ];

    if (args.withMemory) {
        baseNodes.push({
            id: memoryId,
            type: 'memory',
            storage: 'in_memory',
            storage_kind: 'kv',
            handling: 'full_history',
            tool_access: 'none',
            position: { x: 200, y: 120 },
        });
        baseEdges.push({
            id: 'mem->ag',
            source: { node_id: memoryId },
            target: { node_id: agentId },
        });
    }

    if (args.workspaceDir) {
        baseNodes.push({
            id: wsId,
            type: 'workspace',
            path: args.workspaceDir,
            permissions: 'read',
            position: { x: 200, y: 240 },
        });
        baseEdges.push({
            id: 'ws->ag',
            source: { node_id: wsId },
            target: { node_id: agentId },
        });
    }

    const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
        kind: 'l2',
        name: 'cli-demo',
        nodes: [...baseNodes, ...(args.extraNodes ?? [])],
        edges: [...baseEdges, ...(args.extraEdges ?? [])],
    };
    const savedL2 = await graphStore.create(l2);

    const app = buildServer({
        logger: false,
        graphStore,
        channels,
        memoryRegistry,
        cliExecutor: args.executor,
    });

    const load = await inject(app, {
        method: 'POST',
        url: `/api/graphs/${savedL2.id}/load`,
    });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }

    return {
        app,
        channels,
        memoryRegistry,
        ids: { l2Id: savedL2.id!, channelId, agentId, memoryId },
    };
}

describe('CliAgent: WebchatChannel → CliAgent(go-claude) → WebchatChannel', () => {
    let graphsDir: string;
    let workspaceDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-cli-graphs-'));
        workspaceDir = mkdtempSync(join(tmpdir(), 'fabritorio-cli-ws-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it('runs `go-claude new` on the first turn and persists the returned session_id', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: 'session: sess-abc\nhello there',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, channels, memoryRegistry, ids } = await setupCliDemo({
            graphsDir,
            workspaceDir,
            withMemory: true,
            executor,
        });
        try {
            const channel = channels.get(ids.channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            const post = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'hi' },
            });
            expect(post.statusCode).toBe(202);
            await new Promise((r) => setTimeout(r, 30));

            expect(calls).toHaveLength(1);
            expect(calls[0]!.command).toBe('go-claude');
            expect(calls[0]!.argv).toEqual(['new', 'hi']);
            expect(calls[0]!.cwd).toBe(workspaceDir);

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages[0]).toEqual({
                role: 'assistant',
                content: 'hello there',
            });
            expect(replies[0]!.meta?.port).toBe('result');

            const handle = memoryRegistry.get(ids.memoryId)!;
            expect(handle.read(`webchat:${ids.channelId}`)).toBe('sess-abc');
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('uses `continue <session_id>` on subsequent turns from the same source', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: 'session: sess-1\nhi alice',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
            {
                stdout: 'still alice',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, ids } = await setupCliDemo({
            graphsDir,
            withMemory: true,
            executor,
        });
        try {
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: "hi i'm alice" },
            });
            await new Promise((r) => setTimeout(r, 30));
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: "what's my name?" },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls).toHaveLength(2);
            expect(calls[0]!.argv).toEqual(['new', "hi i'm alice"]);
            expect(calls[1]!.argv).toEqual(['continue', 'sess-1', "what's my name?"]);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('isolates session_id per Dispatch source', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: 'session: sess-A\nfirst',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
            {
                stdout: 'session: sess-B\nsecond',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
            {
                stdout: 'still A',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, memoryRegistry, ids } = await setupCliDemo({
            graphsDir,
            withMemory: true,
            executor,
        });
        try {
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'hi', source: 'user:alice' },
            });
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'hi', source: 'user:bob' },
            });
            await new Promise((r) => setTimeout(r, 30));
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'again', source: 'user:alice' },
            });
            await new Promise((r) => setTimeout(r, 30));

            const handle = memoryRegistry.get(ids.memoryId)!;
            expect(handle.read('user:alice')).toBe('sess-A');
            expect(handle.read('user:bob')).toBe('sess-B');

            expect(calls[2]!.argv).toEqual(['continue', 'sess-A', 'again']);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('emits on the error port when the subprocess exits non-zero', async () => {
        const { executor } = mockExecutor([
            { stdout: '', stderr: 'boom', exit_code: 1, timed_out: false },
        ]);
        const { app, channels, ids } = await setupCliDemo({
            graphsDir,
            withMemory: true,
            executor,
        });
        try {
            const channel = channels.get(ids.channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'go' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.meta?.port).toBe('error');
            expect(replies[0]!.messages[0]!.content).toContain('boom');
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('tolerates a forbidden Tool wired into the cli_agent at load', async () => {
        const { executor } = mockExecutor([]);
        const graphStore = createGraphStore({ dir: graphsDir });
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            nodes: [
                {
                    id: 'ag',
                    type: 'cli_agent',
                    command: 'go-claude',
                    session_mode: 'stateless',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'tool-bad',
                    type: 'tool',
                    tool_name: 'read_file',
                    position: { x: 100, y: 0 },
                },
            ],
            edges: [{ id: 't->ag', source: { node_id: 'tool-bad' }, target: { node_id: 'ag' } }],
        };
        const saved = await graphStore.create(l2);
        const app = buildServer({
            logger: false,
            graphStore,
            cliExecutor: executor,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${saved.id}/load`,
            });
            expect(load.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it('parses jsonl output and extracts session_id from a JSON line', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: '{"session_id":"sess-jsonl"}\n{"content":"line one"}\n{"content":"line two"}\n',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const graphStore = createGraphStore({ dir: graphsDir });
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            nodes: [
                {
                    id: 'ch',
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'ag',
                    type: 'cli_agent',
                    command: 'go-claude',
                    session_mode: 'session-aware',
                    output_format: 'jsonl',
                    position: { x: 200, y: 0 },
                },
                {
                    id: 'mem',
                    type: 'memory',
                    storage: 'in_memory',
                    storage_kind: 'kv',
                    handling: 'full_history',
                    tool_access: 'none',
                    position: { x: 200, y: 120 },
                },
            ],
            edges: [
                {
                    id: 'ch->ag',
                    source: { node_id: 'ch', port_id: 'out' },
                    target: { node_id: 'ag', port_id: 'in' },
                },
                {
                    id: 'ag->ch',
                    source: { node_id: 'ag', port_id: 'out' },
                    target: { node_id: 'ch', port_id: 'in' },
                },
                { id: 'mem->ag', source: { node_id: 'mem' }, target: { node_id: 'ag' } },
            ],
        };
        const saved = await graphStore.create(l2);
        const memoryRegistry = createMemoryRegistry();
        const channels = createChannelRegistry();
        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            memoryRegistry,
            cliExecutor: executor,
        });
        try {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${saved.id}/load`,
            });
            const channel = channels.get('ch')!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((event) => {
                if (event.messages?.[0]?.role !== 'user') replies.push(event);
            });

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/ch/message`,
                payload: { content: 'go' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls).toHaveLength(1);
            expect(replies[0]!.messages[0]!.content).toBe('line one\nline two');
            expect(memoryRegistry.get('mem')!.read('webchat:ch')).toBe('sess-jsonl');
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${saved.id}/unload` });
            await app.close();
        }
    });
});
