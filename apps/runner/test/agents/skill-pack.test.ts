import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph, ModelNode } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createChannelRegistry } from '../../src/runtime/channels.js';
import { createSkillRegistry } from '../../src/runtime/skills.js';
import type { CompleteRequest, ModelClient } from '../../src/runtime/model.js';
import { inject } from '../helpers/inject.js';

interface ScriptedReply {
    text?: string;
    tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

function scriptedClient(replies: ScriptedReply[]): ModelClient {
    let i = 0;
    return {
        async *complete(_req: CompleteRequest) {
            const reply = replies[i++];
            if (!reply) throw new Error('scripted client exhausted');
            if (reply.text) yield { delta: reply.text };
            yield {
                delta: '',
                finish_reason: reply.tool_calls ? 'tool_calls' : 'stop',
                ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}),
            };
        },
    };
}

describe('agent resolves wired SkillPack via referenced L0 graph', () => {
    let graphsDir: string;
    let skillsDir: string;

    beforeEach(() => {
        graphsDir = mkdtempSync(join(tmpdir(), 'fabritorio-skillpack-graphs-'));
        skillsDir = mkdtempSync(join(tmpdir(), 'fabritorio-skillpack-skills-'));

        mkdirSync(join(skillsDir, 'haiku'));
        writeFileSync(
            join(skillsDir, 'haiku', 'SKILL.md'),
            [
                '---',
                'name: haiku',
                'description: Write a haiku about a topic.',
                '---',
                '',
                'Compose a 5-7-5 haiku.',
                '',
            ].join('\n'),
            'utf8',
        );

        mkdirSync(join(skillsDir, 'limerick'));
        writeFileSync(
            join(skillsDir, 'limerick', 'SKILL.md'),
            [
                '---',
                'name: limerick',
                'description: Write a limerick.',
                '---',
                '',
                'Compose an AABBA limerick.',
                '',
            ].join('\n'),
            'utf8',
        );
    });

    afterEach(() => {
        rmSync(graphsDir, { recursive: true, force: true });
        rmSync(skillsDir, { recursive: true, force: true });
    });

    it("expands a wired skill_pack's ref_id into the agent's skill set", async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();
        const skillRegistry = createSkillRegistry([skillsDir]);

        const l0: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'skillpack',
            name: 'poetry-pack',
            nodes: [
                {
                    id: 'inner-haiku',
                    type: 'skill',
                    name: 'haiku',
                    position: { x: 0, y: 0 },
                },
                {
                    id: 'inner-limerick',
                    type: 'skill',
                    name: 'limerick',
                    position: { x: 0, y: 80 },
                },
            ],
            edges: [],
        };
        const savedL0 = await graphStore.create(l0);

        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'agent-with-skillpack',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                {
                    id: 'h1',
                    type: 'handler',
                    name: 'SimpleHandler',
                    max_iterations: 4,
                    position: { x: 100, y: 0 },
                },
                {
                    id: 'out',
                    type: 'output',
                    ports: ['result', 'error'],
                    position: { x: 200, y: 0 },
                },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/gpt',
                    system_prompt: 'you write poems',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'spack-1',
                    type: 'skill_pack',
                    pack_name: 'poetry',
                    ref_id: savedL0.id!,
                    position: { x: 100, y: 160 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                {
                    id: 'spack->h',
                    source: { node_id: 'spack-1' },
                    target: { node_id: 'h1' },
                },
            ],
        };
        const savedL1 = await graphStore.create(l1);

        const channelId = 'ch-spack';
        const agentId = 'ag-spack';
        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'demo',
            nodes: [
                {
                    id: channelId,
                    type: 'channel',
                    channel_kind: 'webchat',
                    position: { x: 0, y: 0 },
                },
                {
                    id: agentId,
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [
                {
                    id: 'ch->ag',
                    source: { node_id: channelId },
                    target: { node_id: agentId },
                },
                {
                    id: 'ag->ch',
                    source: { node_id: agentId },
                    target: { node_id: channelId },
                },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const captured: CompleteRequest[] = [];
        const baseClient = scriptedClient([
            {
                tool_calls: [
                    {
                        id: 'call-load',
                        name: 'Skill',
                        arguments: JSON.stringify({ name: 'haiku' }),
                    },
                ],
            },
            { text: 'spring rain falls / on the cherry blossoms / a quiet sigh' },
        ]);
        const wrapped: ModelClient = {
            async *complete(req) {
                captured.push(req);
                yield* baseClient.complete(req);
            },
        };

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            skillRegistry,
            modelClientFor: (_node: ModelNode) => wrapped,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            const channel = channels.get(channelId)!;
            const replies: DispatchEvent[] = [];
            channel.subscribe((e) => {
                if (e.messages?.[0]?.role !== 'user') replies.push(e);
            });

            const post = await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/${channelId}/message`,
                payload: { content: 'write a haiku about spring' },
            });
            expect(post.statusCode).toBe(202);

            await new Promise((r) => setTimeout(r, 30));

            expect(replies).toHaveLength(1);
            expect(replies[0]!.messages[0]!.content).toMatch(/cherry blossoms/);
            expect(replies[0]!.meta?.port).toBe('result');

            const firstReq = captured[0]!;
            const advertisedNames = firstReq.tools?.map((t) => t.name) ?? [];
            expect(advertisedNames).toContain('Skill');

            const sysMsg = firstReq.messages.find((m) => m.role === 'system');
            expect(sysMsg?.content).toMatch(/haiku/);
            expect(sysMsg?.content).toMatch(/Write a haiku about a topic/);
            expect(sysMsg?.content).toMatch(/limerick/);
            expect(sysMsg?.content).toMatch(/Write a limerick/);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/unload`,
            });
            await app.close();
        }
    });

    it('dedupes when a skill is wired both directly and via a pack', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();
        const skillRegistry = createSkillRegistry([skillsDir]);

        const l0: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'skillpack',
            name: 'poetry-pack',
            nodes: [
                {
                    id: 'inner-haiku',
                    type: 'skill',
                    name: 'haiku',
                    position: { x: 0, y: 0 },
                },
            ],
            edges: [],
        };
        const savedL0 = await graphStore.create(l0);

        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'agent-with-dup-skill',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'h1', type: 'handler', max_iterations: 1, position: { x: 100, y: 0 } },
                {
                    id: 'out',
                    type: 'output',
                    ports: ['result', 'error'],
                    position: { x: 200, y: 0 },
                },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/gpt',
                    position: { x: 100, y: 80 },
                },
                { id: 'haiku-direct', type: 'skill', name: 'haiku', position: { x: 100, y: 160 } },
                {
                    id: 'spack-1',
                    type: 'skill_pack',
                    ref_id: savedL0.id!,
                    position: { x: 100, y: 240 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                {
                    id: 'haiku->h',
                    source: { node_id: 'haiku-direct' },
                    target: { node_id: 'h1' },
                },
                {
                    id: 'spack->h',
                    source: { node_id: 'spack-1' },
                    target: { node_id: 'h1' },
                },
            ],
        };
        const savedL1 = await graphStore.create(l1);

        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'demo',
            nodes: [
                { id: 'ch', type: 'channel', channel_kind: 'webchat', position: { x: 0, y: 0 } },
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [
                { id: 'ch->ag', source: { node_id: 'ch' }, target: { node_id: 'ag' } },
                { id: 'ag->ch', source: { node_id: 'ag' }, target: { node_id: 'ch' } },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const captured: CompleteRequest[] = [];
        const wrapped: ModelClient = {
            async *complete(req) {
                captured.push(req);
                yield { delta: '', finish_reason: 'stop' };
            },
        };

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            skillRegistry,
            modelClientFor: () => wrapped,
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);

            const channel = channels.get('ch')!;
            channel.subscribe(() => undefined);

            await inject(app, {
                method: 'POST',
                url: `/api/channels/webchat/ch/message`,
                payload: { content: 'hi' },
            });

            await new Promise((r) => setTimeout(r, 30));

            const sysMsg = captured[0]!.messages.find((m) => m.role === 'system');
            const entries = (sysMsg?.content ?? '').match(/^- haiku:/gm) ?? [];
            expect(entries.length).toBe(1);
        } finally {
            await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/unload`,
            });
            await app.close();
        }
    });

    it('rejects load when a wired skill_pack ref_id points at a missing graph', async () => {
        const graphStore = createGraphStore({ dir: graphsDir });
        const channels = createChannelRegistry();
        const skillRegistry = createSkillRegistry([skillsDir]);

        const l1: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l1',
            name: 'broken-skill-ref',
            nodes: [
                { id: 'gw', type: 'gateway', position: { x: 0, y: 0 } },
                { id: 'h1', type: 'handler', max_iterations: 1, position: { x: 100, y: 0 } },
                {
                    id: 'out',
                    type: 'output',
                    ports: ['result', 'error'],
                    position: { x: 200, y: 0 },
                },
                {
                    id: 'm1',
                    type: 'model',
                    provider: 'fake',
                    model_id: 'fake/gpt',
                    position: { x: 100, y: 80 },
                },
                {
                    id: 'spack-1',
                    type: 'skill_pack',
                    ref_id: '11111111-1111-4111-8111-111111111111',
                    position: { x: 100, y: 160 },
                },
            ],
            edges: [
                { id: 'gw->h', source: { node_id: 'gw' }, target: { node_id: 'h1' } },
                { id: 'h->out', source: { node_id: 'h1' }, target: { node_id: 'out' } },
                { id: 'm->h', source: { node_id: 'm1' }, target: { node_id: 'h1' } },
                {
                    id: 'spack->h',
                    source: { node_id: 'spack-1' },
                    target: { node_id: 'h1' },
                },
            ],
        };
        const savedL1 = await graphStore.create(l1);

        const l2: Omit<Graph, 'id' | 'created_at' | 'updated_at'> = {
            kind: 'l2',
            name: 'demo',
            nodes: [
                { id: 'ch', type: 'channel', channel_kind: 'webchat', position: { x: 0, y: 0 } },
                {
                    id: 'ag',
                    type: 'native_agent',
                    l1_graph_id: savedL1.id!,
                    position: { x: 200, y: 0 },
                },
            ],
            edges: [
                { id: 'ch->ag', source: { node_id: 'ch' }, target: { node_id: 'ag' } },
                { id: 'ag->ch', source: { node_id: 'ag' }, target: { node_id: 'ch' } },
            ],
        };
        const savedL2 = await graphStore.create(l2);

        const app = buildServer({
            logger: false,
            graphStore,
            channels,
            skillRegistry,
            modelClientFor: () => ({
                async *complete() {
                    yield { delta: '', finish_reason: 'stop' };
                },
            }),
        });
        try {
            const load = await inject(app, {
                method: 'POST',
                url: `/api/graphs/${savedL2.id}/load`,
            });
            expect(load.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });
});
