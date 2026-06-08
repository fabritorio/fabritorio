import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillTool } from '../../src/runtime/tools.js';
import { createSkillRegistry } from '../../src/runtime/skills.js';

function writeSkill(root: string, name: string, body: string) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
        join(root, name, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${name} skill.`, '---', '', body, ''].join('\n'),
        'utf8',
    );
}

describe('Skill tool', () => {
    let skillsDir: string;

    beforeEach(() => {
        skillsDir = mkdtempSync(join(tmpdir(), 'fabritorio-skill-tool-'));
    });

    afterEach(() => {
        rmSync(skillsDir, { recursive: true, force: true });
    });

    it('returns the body for a known skill', async () => {
        writeSkill(skillsDir, 'haiku', 'Compose a 5-7-5 haiku.');
        const tool = createSkillTool(createSkillRegistry([skillsDir]));
        const result = await tool.handler({ name: 'haiku' }, { call_id: 'c1', eventId: 'e1' });
        expect(result.exit_code).toBe(0);
        expect(result.stdout).toContain('Compose a 5-7-5 haiku.');
        expect(result.stderr).toBe('');
    });

    it('re-scans the skill roots when a name misses and resolves a newly-written skill', async () => {
        const registry = createSkillRegistry([skillsDir]);
        const tool = createSkillTool(registry);

        writeSkill(skillsDir, 'linear', 'List Linear issues.');

        const result = await tool.handler({ name: 'linear' }, { call_id: 'c1', eventId: 'e1' });
        expect(result.exit_code).toBe(0);
        expect(result.stdout).toContain('List Linear issues.');
        expect(result.stderr).toBe('');
    });

    it('still fails when the skill genuinely does not exist on disk', async () => {
        const tool = createSkillTool(createSkillRegistry([skillsDir]));
        const result = await tool.handler({ name: 'nope' }, { call_id: 'c1', eventId: 'e1' });
        expect(result.exit_code).toBe(1);
        expect(result.stderr).toBe('unknown skill "nope"');
    });

    it('enforces the allowedNames gate before touching the registry', async () => {
        writeSkill(skillsDir, 'haiku', 'Compose a 5-7-5 haiku.');
        const tool = createSkillTool(createSkillRegistry([skillsDir]), new Set(['limerick']));
        const result = await tool.handler({ name: 'haiku' }, { call_id: 'c1', eventId: 'e1' });
        expect(result.exit_code).toBe(1);
        expect(result.stderr).toBe('skill "haiku" is not wired to this agent');
    });

    it('returns a named resource file instead of the body (suffix optional)', async () => {
        writeSkill(skillsDir, 'foreman', 'Core playbook.');
        writeFileSync(
            join(skillsDir, 'foreman', 'recipe-build-agent.md'),
            'How to build an agent.',
            'utf8',
        );
        const tool = createSkillTool(createSkillRegistry([skillsDir]));

        for (const resource of ['recipe-build-agent', 'recipe-build-agent.md']) {
            const result = await tool.handler(
                { name: 'foreman', resource },
                { call_id: 'c1', eventId: 'e1' },
            );
            expect(result.exit_code).toBe(0);
            expect(result.stdout).toBe('How to build an agent.');
            expect(result.stdout).not.toContain('Core playbook.');
        }
    });

    it('errors with the available list when the resource is unknown', async () => {
        writeSkill(skillsDir, 'foreman', 'Core playbook.');
        writeFileSync(join(skillsDir, 'foreman', 'recipe-build-agent.md'), 'x', 'utf8');
        const tool = createSkillTool(createSkillRegistry([skillsDir]));
        const result = await tool.handler(
            { name: 'foreman', resource: 'nope' },
            { call_id: 'c1', eventId: 'e1' },
        );
        expect(result.exit_code).toBe(1);
        expect(result.stderr).toContain('has no resource "nope"');
        expect(result.stderr).toContain('recipe-build-agent.md');
    });

    it('enforces the allowedNames gate on resource fetches too', async () => {
        writeSkill(skillsDir, 'foreman', 'Core playbook.');
        writeFileSync(join(skillsDir, 'foreman', 'recipe-build-agent.md'), 'x', 'utf8');
        const tool = createSkillTool(createSkillRegistry([skillsDir]), new Set(['other']));
        const result = await tool.handler(
            { name: 'foreman', resource: 'recipe-build-agent' },
            { call_id: 'c1', eventId: 'e1' },
        );
        expect(result.exit_code).toBe(1);
        expect(result.stderr).toBe('skill "foreman" is not wired to this agent');
    });
});
