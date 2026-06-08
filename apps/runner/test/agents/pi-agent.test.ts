import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import { createMemoryRegistry } from '../../src/runtime/memory.js';
import { createSkillRegistry } from '../../src/runtime/skills.js';
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

function piJsonStream(args: {
    sessionId?: string;
    reply: string;
    stopReason?: 'stop' | 'error' | 'aborted';
    errorMessage?: string;
}): string {
    const lines: string[] = [];
    if (args.sessionId) {
        lines.push(
            JSON.stringify({
                type: 'session',
                version: 3,
                id: args.sessionId,
                timestamp: '2026-04-29T00:00:00.000Z',
                cwd: '/tmp/x',
            }),
        );
    }
    lines.push(JSON.stringify({ type: 'agent_start' }));
    lines.push(JSON.stringify({ type: 'turn_start' }));
    const finalAssistant = {
        role: 'assistant',
        content: [{ type: 'text', text: args.reply }],
        api: 'anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        usage: {},
        stopReason: args.stopReason ?? 'stop',
        ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
        timestamp: 1700000000000,
    };
    lines.push(
        JSON.stringify({
            type: 'turn_end',
            message: finalAssistant,
            toolResults: [],
        }),
    );
    lines.push(
        JSON.stringify({
            type: 'agent_end',
            messages: [{ role: 'user', content: 'hi', timestamp: 1700000000000 }, finalAssistant],
        }),
    );
    return `${lines.join('\n')}\n`;
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
    provider?: string;
    model?: string;
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

    const channelId = 'ch-pi';
    const agentId = 'ag-pi';
    const memoryId = 'mem-pi';
    const wsId = 'ws-pi';

    const baseNodes: Graph['nodes'] = [
        {
            id: channelId,
            type: 'channel',
            channel_kind: 'webchat',
            position: { x: 0, y: 0 },
        },
        {
            id: agentId,
            type: 'pi_agent',
            session_mode: args.sessionMode ?? 'session-aware',
            ...(args.provider ? { provider: args.provider } : {}),
            ...(args.model ? { model: args.model } : {}),
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
        name: 'pi-demo',
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

describe('PiAgent: WebchatChannel → PiAgent(--mode json) → WebchatChannel', () => {
    let graphsDir: string;
    let workspaceDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-pi-graphs-'));
        workspaceDir = mkdtempSync(join(tmpdir(), 'fabritorio-pi-ws-'));
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it('first turn: no `--session` flag, parses session id from JSONL header, returns concatenated text', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: piJsonStream({ sessionId: 'sess-abc', reply: 'hello there' }),
                stderr: '',
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
            expect(calls[0]!.command).toBe('pi');
            expect(calls[0]!.argv).toEqual(['--mode', 'json', 'hi']);
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
            await inject(app, { method: 'POST', url: `/api/graphs/${ids.l2Id}/unload` });
            await app.close();
        }
    });

    it('subsequent turn: reuses stored session id with `--session <id>`', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: piJsonStream({ sessionId: 'sess-1', reply: 'hi alice' }),
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
            {
                stdout: piJsonStream({ sessionId: 'sess-1', reply: 'still alice' }),
                stderr: '',
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
            expect(calls[0]!.argv).toEqual(['--mode', 'json', "hi i'm alice"]);
            expect(calls[1]!.argv).toEqual([
                '--mode',
                'json',
                '--session',
                'sess-1',
                "what's my name?",
            ]);
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${ids.l2Id}/unload` });
            await app.close();
        }
    });

    it('stateless mode adds `--no-session` and forwards provider/model flags', async () => {
        const { executor, calls } = mockExecutor([
            {
                stdout: piJsonStream({ reply: 'answer' }),
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, ids } = await setupDemo({
            graphsDir,
            withMemory: false,
            sessionMode: 'stateless',
            provider: 'anthropic',
            model: 'sonnet:high',
            executor,
        });
        try {
            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${ids.channelId}/message`,
                payload: { content: 'explain X' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls[0]!.argv).toEqual([
                '--mode',
                'json',
                '--no-session',
                '--provider',
                'anthropic',
                '--model',
                'sonnet:high',
                'explain X',
            ]);
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${ids.l2Id}/unload` });
            await app.close();
        }
    });

    it('emits on the error port when the final assistant message has stopReason `error`', async () => {
        const { executor } = mockExecutor([
            {
                stdout: piJsonStream({
                    sessionId: 'sess-fail',
                    reply: '',
                    stopReason: 'error',
                    errorMessage: 'rate limit exceeded',
                }),
                stderr: '',
                exit_code: 0,
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
            expect(replies[0]!.messages[0]!.content).toContain('rate limit exceeded');

            const handle = memoryRegistry.get(ids.memoryId)!;
            expect(handle.read(`webchat:${ids.channelId}`)).toBeUndefined();
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${ids.l2Id}/unload` });
            await app.close();
        }
    });

    it('emits on the error port when stdout has no agent_end (pi died mid-stream)', async () => {
        const { executor } = mockExecutor([
            {
                stdout: `${JSON.stringify({ type: 'session', version: 3, id: 'sess-x' })}\n`,
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const { app, channels, ids } = await setupDemo({
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
                payload: { content: 'hi' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.meta?.port).toBe('error');
            expect(replies[0]!.messages[0]!.content).toContain('agent_end');
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${ids.l2Id}/unload` });
            await app.close();
        }
    });

    it('forwards wired Skill and SkillPack nodes as repeated `--skill <path>` flags', async () => {
        const skillsDir = mkdtempSync(join(tmpdir(), 'fabritorio-pi-skills-'));
        mkdirSync(join(skillsDir, 'haiku'));
        writeFileSync(
            join(skillsDir, 'haiku', 'SKILL.md'),
            '---\nname: haiku\ndescription: Write a haiku.\n---\nCompose 5-7-5.\n',
            'utf8',
        );
        mkdirSync(join(skillsDir, 'limerick'));
        writeFileSync(
            join(skillsDir, 'limerick', 'SKILL.md'),
            '---\nname: limerick\ndescription: Write a limerick.\n---\nCompose AABBA.\n',
            'utf8',
        );

        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();
        const memoryRegistry = createMemoryRegistry();
        const skillRegistry = createSkillRegistry([skillsDir]);

        const l0: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'skillpack',
            name: 'poetry-pack',
            nodes: [
                {
                    id: 'inner-limerick',
                    type: 'skill',
                    name: 'limerick',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        };
        const savedL0 = await graphStore.create(l0);

        const channelId = 'ch-pi-skills';
        const agentId = 'ag-pi-skills';
        const skillId = 'sk-haiku';
        const packId = 'sp-poetry';

        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'pi-with-skills',
            nodes: [
                {
                    id: channelId,
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: agentId,
                    type: 'pi_agent',
                    session_mode: 'stateless',
                    position: { x: 200, y: 0 },
                },
                {
                    id: skillId,
                    type: 'skill',
                    name: 'haiku',
                    position: { x: 200, y: 120 },
                },
                {
                    id: packId,
                    type: 'skill_pack',
                    ref_id: savedL0.id!,
                    position: { x: 200, y: 240 },
                },
            ],
            edges: [
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
                {
                    id: 'sk->ag',
                    source: { node_id: skillId },
                    target: { node_id: agentId },
                },
                {
                    id: 'sp->ag',
                    source: { node_id: packId },
                    target: { node_id: agentId },
                },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const { executor, calls } = mockExecutor([
            {
                stdout: piJsonStream({ reply: 'ok' }),
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            memoryRegistry,
            skillRegistry,
            cliExecutor: executor,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${channelId}/message`,
                payload: { content: 'haiku me' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls).toHaveLength(1);
            const argv = calls[0]!.argv;
            expect(argv).toEqual([
                '--mode',
                'json',
                '--no-session',
                '--skill',
                join(skillsDir, 'haiku'),
                '--skill',
                join(skillsDir, 'limerick'),
                'haiku me',
            ]);
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${savedL2.id}/unload` });
            await app.close();
            rmSync(skillsDir, { recursive: true, force: true });
        }
    });

    it('inner cli_invocation graph supplies provider/model/cwd/skills, overriding legacy node fields', async () => {
        const skillsDir = mkdtempSync(join(tmpdir(), 'fabritorio-pi-cli-cfg-'));
        mkdirSync(join(skillsDir, 'alpha'));
        writeFileSync(
            join(skillsDir, 'alpha', 'SKILL.md'),
            '---\nname: alpha\ndescription: Alpha skill.\n---\nA.\n',
            'utf8',
        );
        mkdirSync(join(skillsDir, 'beta'));
        writeFileSync(
            join(skillsDir, 'beta', 'SKILL.md'),
            '---\nname: beta\ndescription: Beta skill.\n---\nB.\n',
            'utf8',
        );
        const innerCwd = mkdtempSync(join(tmpdir(), 'fabritorio-pi-cwd-'));

        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();
        const memoryRegistry = createMemoryRegistry();
        const skillRegistry = createSkillRegistry([skillsDir]);

        const skillPack = await graphStore.create({
            kind: 'skillpack',
            name: 'beta-pack',
            nodes: [
                {
                    id: 'inner-beta',
                    type: 'skill',
                    name: 'beta',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        });

        const cliInvocation = await graphStore.create({
            kind: 'cli_invocation',
            name: 'pi config (inner)',
            nodes: [
                {
                    id: 'cfg-model',
                    type: 'model',
                    provider: 'anthropic',
                    model_id: 'sonnet:medium',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'cfg-ws',
                    type: 'workspace',
                    path: innerCwd,
                    permissions: 'read',
                    position: { x: 200, y: 0 },
                },
                {
                    id: 'cfg-skill-alpha',
                    type: 'skill',
                    name: 'alpha',
                    position: { x: 0, y: 200 },
                },
                {
                    id: 'cfg-pack',
                    type: 'skill_pack',
                    ref_id: skillPack.id!,
                    position: { x: 200, y: 200 },
                },
            ],
            edges: [],
        });

        const channelId = 'ch-pi-cfg';
        const agentId = 'ag-pi-cfg';

        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'pi-with-cli-invocation',
            nodes: [
                {
                    id: channelId,
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: agentId,
                    type: 'pi_agent',
                    session_mode: 'stateless',
                    provider: 'openai',
                    model: 'gpt-3.5',
                    cwd: '/tmp/legacy-noise',
                    ref_id: cliInvocation.id!,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [
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
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const { executor, calls } = mockExecutor([
            {
                stdout: piJsonStream({ reply: 'ok' }),
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            memoryRegistry,
            skillRegistry,
            cliExecutor: executor,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${channelId}/message`,
                payload: { content: 'go' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls).toHaveLength(1);
            expect(calls[0]!.argv).toEqual([
                '--mode',
                'json',
                '--no-session',
                '--provider',
                'anthropic',
                '--model',
                'sonnet:medium',
                '--skill',
                join(skillsDir, 'alpha'),
                '--skill',
                join(skillsDir, 'beta'),
                'go',
            ]);
            expect(calls[0]!.cwd).toBe(innerCwd);
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${savedL2.id}/unload` });
            await app.close();
            rmSync(skillsDir, { recursive: true, force: true });
            rmSync(innerCwd, { recursive: true, force: true });
        }
    });

    it('prepends wired context-purpose Memory content to the user query', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();
        const memoryRegistry = createMemoryRegistry();

        const channelId = 'ch-pi-ctx';
        const agentId = 'ag-pi-ctx';
        const ctxId = 'mem-ctx';
        const sessId = 'mem-sess';

        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'pi-ctx-memory',
            nodes: [
                {
                    id: channelId,
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: agentId,
                    type: 'pi_agent',
                    session_mode: 'stateless',
                    position: { x: 200, y: 0 },
                },
                {
                    id: ctxId,
                    type: 'memory',
                    storage: 'in_memory',
                    storage_kind: 'static_string',
                    handling: 'always_inject',
                    tool_access: 'none',
                    content: 'User prefers terse answers.\nUser writes TypeScript.',
                    position: { x: 200, y: 120 },
                },
                {
                    id: sessId,
                    type: 'memory',
                    storage: 'in_memory',
                    storage_kind: 'kv',
                    handling: 'full_history',
                    tool_access: 'none',
                    position: { x: 200, y: 240 },
                },
            ],
            edges: [
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
                {
                    id: 'ctx->ag',
                    source: { node_id: ctxId },
                    target: { node_id: agentId },
                },
                {
                    id: 'sess->ag',
                    source: { node_id: sessId },
                    target: { node_id: agentId },
                },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const { executor, calls } = mockExecutor([
            {
                stdout: piJsonStream({ reply: 'ok' }),
                stderr: '',
                exit_code: 0,
                timed_out: false,
            },
        ]);
        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            memoryRegistry,
            cliExecutor: executor,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${channelId}/message`,
                payload: { content: 'what should I do?' },
            });
            await new Promise((r) => setTimeout(r, 30));

            expect(calls).toHaveLength(1);
            const argv = calls[0]!.argv;
            const query = argv[argv.length - 1];
            expect(query).toBe(
                'User prefers terse answers.\nUser writes TypeScript.\n\nwhat should I do?',
            );
        } finally {
            await inject(app, { method: 'POST', url: `/api/graphs/${savedL2.id}/unload` });
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
                    type: 'pi_agent',
                    session_mode: 'stateless',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'model-bad',
                    type: 'model',
                    model_id: 'claude-sonnet-4',
                    position: { x: 0, y: 200 },
                },
            ],
            edges: [
                {
                    id: 'm->ag',
                    source: { node_id: 'model-bad' },
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
