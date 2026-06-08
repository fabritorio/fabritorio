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

interface DemoIds {
    l2Id: string;
    channelId: string;
    agentId: string;
    memoryId: string;
}

async function setupDemo(args: {
    graphsDir: string;
    workspaceDir?: string;
    withMemory?: boolean;
    sessionMode?: 'stateless' | 'session-aware';
    sessionName?: string;
    executor: CliExecutor;
}): Promise<{
    app: ReturnType<typeof buildServer>;
    channels: ReturnType<typeof createChannelRegistry>;
    memoryRegistry: ReturnType<typeof createMemoryRegistry>;
    ids: DemoIds;
}> {
    const graphStore = createGraphStore({ dir: args.graphsDir });
    const channels = createChannelRegistry();
    const memoryRegistry = createMemoryRegistry();

    const channelId = 'ch-gc';
    const agentId = 'ag-gc';
    const memoryId = 'mem-gc';
    const wsId = 'ws-gc';

    const baseNodes: Graph['nodes'] = [
        {
            id: channelId,
            type: 'channel',
            channel_kind: 'webchat',
            position: { x: 0, y: 0 },
        },
        {
            id: agentId,
            type: 'go_claude_agent',
            session_mode: args.sessionMode ?? 'session-aware',
            ...(args.sessionName ? { session_name: args.sessionName } : {}),
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
        name: 'go-claude-demo',
        nodes: baseNodes,
        edges: baseEdges,
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

describe('GoClaudeAgent: WebchatChannel → GoClaudeAgent → WebchatChannel', () => {
    let graphsDir: string;
    let workspaceDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-gc-graphs-'));
        workspaceDir = mkdtempSync(join(tmpdir(), 'fabritorio-gc-ws-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it('runs `go-claude new <q>` on the first turn and persists the session id parsed from stderr', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: 'hello there\n',
                stderr: '[log: /tmp/go-claude/logs/x.jsonl]\n[session: sess-abc]\n',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, channels, memoryRegistry, ids } = await setupDemo({
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

    it('uses `continue <session_id> <q>` on subsequent turns from the same source', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: 'hi alice\n',
                stderr: '[session: sess-1]\n',
                exit_code: 0,
                timed_out: false,
            },
            {
                stdout: 'still alice\n',
                stderr: '[session: sess-1]\n',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, ids } = await setupDemo({
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

    it('threads `--name` into `go-claude new` when `session_name` is set on the node', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: 'ok\n',
                stderr: '[session: my-review]\n',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, ids } = await setupDemo({
            graphsDir,
            withMemory: true,
            sessionName: 'my-review',
            executor,
        });
        try {
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'start review' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls[0]!.argv).toEqual(['new', '--name', 'my-review', 'start review']);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('runs one-shot argv (no `new`/`continue`) in stateless mode', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: 'explanation\n',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, ids } = await setupDemo({
            graphsDir,
            withMemory: false,
            sessionMode: 'stateless',
            executor,
        });
        try {
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'explain X' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls).toHaveLength(1);
            expect(calls[0]!.argv).toEqual(['explain X']);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('emits on the error port when go-claude exits non-zero, and does not poison memory', async () => {
        const { executor } = mockExecutor([
            {
                stdout: '',
                stderr: 'claude reported an error (see /tmp/x.jsonl)\n',
                exit_code: 1,
                timed_out: false,
            },
        ]);
        const { app, channels, memoryRegistry, ids } = await setupDemo({
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
                payload: { content: 'boom' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.meta?.port).toBe('error');
            expect(replies[0]!.messages[0]!.content).toContain('[error]');

            const handle = memoryRegistry.get(ids.memoryId)!;
            expect(handle.read(`webchat:${ids.channelId}`)).toBeUndefined();
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${ids.l2Id}/unload`,
            });
            await app.close();
        }
    });

    it('tolerates forbidden L2 attachments at load (Tool / Model / Handler / ToolPack)', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const memoryRegistry = createMemoryRegistry();

        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'bad',
            nodes: [
                {
                    id: 'ag',
                    type: 'go_claude_agent',
                    session_mode: 'stateless',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'tool-bad',
                    type: 'tool',
                    tool_name: 'read_file',
                    position: { x: 0, y: 200 },
                },
            ],
            edges: [
                {
                    id: 't->ag',
                    source: { node_id: 'tool-bad' },
                    target: { node_id: 'ag' },
                },
            ],
        };
        const saved = await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            memoryRegistry,
            cliExecutor: async () => ({
                stdout: '',
                stderr: '',
                exit_code: 0,
                timed_out: false,
            }),
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
});
