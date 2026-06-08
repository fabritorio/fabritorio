import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerSkillRoutes } from '../../src/routes/skills.js';
import { createSkillRegistry } from '../../src/runtime/skills.js';

describe('skill routes', () => {
    let skillsDir: string;

    beforeEach(() => {
        skillsDir = mkdtempSync(join(tmpdir(), 'fabritorio-skill-routes-'));
    });

    afterEach(() => {
        rmSync(skillsDir, { recursive: true, force: true });
    });

    it('lists discovered skills with name + description', async () => {
        mkdirSync(join(skillsDir, 'summarize'));
        writeFileSync(
            join(skillsDir, 'summarize', 'SKILL.md'),
            [
                '---',
                'name: summarize',
                'description: Condense a long document.',
                '---',
                '',
                'Body.',
            ].join('\n'),
            'utf8',
        );
        mkdirSync(join(skillsDir, 'translate'));
        writeFileSync(
            join(skillsDir, 'translate', 'SKILL.md'),
            [
                '---',
                'name: translate',
                'description: Translate between languages.',
                '---',
                '',
                'Body.',
            ].join('\n'),
            'utf8',
        );

        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const res = await app.inject({ method: 'GET', url: '/api/skills' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
                skills: Array<{ name: string; description: string }>;
            };
            const names = body.skills.map((s) => s.name).sort();
            expect(names).toEqual(['summarize', 'translate']);
            const summarize = body.skills.find((s) => s.name === 'summarize');
            expect(summarize?.description).toBe('Condense a long document.');
        } finally {
            await app.close();
        }
    });

    it('reflects skills written to disk after registry construction', async () => {
        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const before = await app.inject({ method: 'GET', url: '/api/skills' });
            expect((before.json() as { skills: unknown[] }).skills).toEqual([]);

            mkdirSync(join(skillsDir, 'linear'));
            writeFileSync(
                join(skillsDir, 'linear', 'SKILL.md'),
                [
                    '---',
                    'name: linear',
                    'description: Query Linear issues.',
                    '---',
                    '',
                    'Body.',
                ].join('\n'),
                'utf8',
            );

            const after = await app.inject({ method: 'GET', url: '/api/skills' });
            const body = after.json() as {
                skills: Array<{ name: string; description: string }>;
            };
            expect(body.skills.map((s) => s.name)).toEqual(['linear']);
            expect(body.skills[0]?.description).toBe('Query Linear issues.');
        } finally {
            await app.close();
        }
    });

    it('returns an empty list when no skills are discovered', async () => {
        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const res = await app.inject({ method: 'GET', url: '/api/skills' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { skills: unknown[] };
            expect(body.skills).toEqual([]);
        } finally {
            await app.close();
        }
    });

    it('GET /skills/:name returns the full skill plus verbatim SKILL.md', async () => {
        const raw = ['---', 'name: summarize', 'description: Condense.', '---', '', '# Body'].join(
            '\n',
        );
        mkdirSync(join(skillsDir, 'summarize'));
        writeFileSync(join(skillsDir, 'summarize', 'SKILL.md'), raw, 'utf8');

        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const res = await app.inject({ method: 'GET', url: '/api/skills/summarize' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { skill: { name: string; body: string }; raw: string };
            expect(body.skill.name).toBe('summarize');
            expect(body.skill.body).toBe('# Body');
            expect(body.raw).toBe(raw);
        } finally {
            await app.close();
        }
    });

    it('GET /skills/:name 404s for an unknown skill', async () => {
        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const res = await app.inject({ method: 'GET', url: '/api/skills/nope' });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('PUT /skills/:name creates a new skill on disk and lists it', async () => {
        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const raw = [
                '---',
                'name: planner',
                'description: Plan work.',
                '---',
                '',
                '# Plan',
            ].join('\n');
            const put = await app.inject({
                method: 'PUT',
                url: '/api/skills/planner',
                payload: { content: raw },
            });
            expect(put.statusCode).toBe(200);
            const saved = put.json() as { skill: { name: string }; raw: string };
            expect(saved.skill.name).toBe('planner');
            expect(saved.raw).toBe(raw);

            const list = await app.inject({ method: 'GET', url: '/api/skills' });
            const names = (list.json() as { skills: Array<{ name: string }> }).skills.map(
                (s) => s.name,
            );
            expect(names).toContain('planner');
        } finally {
            await app.close();
        }
    });

    it('PUT /skills/:name overwrites an existing skill', async () => {
        mkdirSync(join(skillsDir, 'edit-me'));
        writeFileSync(
            join(skillsDir, 'edit-me', 'SKILL.md'),
            ['---', 'name: edit-me', 'description: old', '---', '', 'old body'].join('\n'),
            'utf8',
        );
        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const next = ['---', 'name: edit-me', 'description: new', '---', '', 'new body'].join(
                '\n',
            );
            const put = await app.inject({
                method: 'PUT',
                url: '/api/skills/edit-me',
                payload: { content: next },
            });
            expect(put.statusCode).toBe(200);

            const get = await app.inject({ method: 'GET', url: '/api/skills/edit-me' });
            const body = get.json() as { skill: { description: string }; raw: string };
            expect(body.skill.description).toBe('new');
            expect(body.raw).toBe(next);
        } finally {
            await app.close();
        }
    });

    it('PUT /skills/:name rejects an unsafe name without touching disk', async () => {
        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const res = await app.inject({
                method: 'PUT',
                url: `/api/skills/${encodeURIComponent('../escape')}`,
                payload: { content: 'x' },
            });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('PUT /skills/:name rejects a non-string content', async () => {
        const app = Fastify({ logger: false });
        app.register(
            async (api) =>
                registerSkillRoutes(api, { skillRegistry: createSkillRegistry([skillsDir]) }),
            { prefix: '/api' },
        );
        try {
            const res = await app.inject({
                method: 'PUT',
                url: '/api/skills/planner',
                payload: { content: 42 },
            });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });
});
