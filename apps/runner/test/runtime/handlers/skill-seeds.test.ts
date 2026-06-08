import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEED_SKILLS_DIR, seedSkills } from '../../../src/runtime/handlers/skill-seeds.js';

describe('seedSkills', () => {
    let targetRoot: string;

    beforeEach(() => {
        targetRoot = mkdtempSync(join(tmpdir(), 'fabritorio-skill-seeds-'));
    });

    afterEach(() => {
        rmSync(targetRoot, { recursive: true, force: true });
    });

    it('seeds the shipped system skills into an empty target root', () => {
        const seeded = seedSkills(SEED_SKILLS_DIR, targetRoot);

        expect(seeded.sort()).toEqual(['foreman', 'skill-builder', 'tool-builder']);
        expect(existsSync(join(targetRoot, 'foreman', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(targetRoot, 'tool-builder', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(targetRoot, 'skill-builder', 'SKILL.md'))).toBe(true);
    });

    it('is idempotent — a second run seeds nothing and preserves an edited copy', () => {
        mkdirSync(join(targetRoot, 'foreman'), { recursive: true });
        const sentinel = '# user-edited foreman skill\n';
        writeFileSync(join(targetRoot, 'foreman', 'SKILL.md'), sentinel);

        const seeded = seedSkills(SEED_SKILLS_DIR, targetRoot);

        expect(seeded.sort()).toEqual(['skill-builder', 'tool-builder']);
        expect(readFileSync(join(targetRoot, 'foreman', 'SKILL.md'), 'utf8')).toBe(sentinel);

        expect(seedSkills(SEED_SKILLS_DIR, targetRoot)).toEqual([]);
    });

    it('seeded SKILL.md content matches the shipped source verbatim', () => {
        seedSkills(SEED_SKILLS_DIR, targetRoot);

        for (const name of ['foreman', 'tool-builder', 'skill-builder']) {
            const src = readFileSync(join(SEED_SKILLS_DIR, name, 'SKILL.md'), 'utf8');
            const dest = readFileSync(join(targetRoot, name, 'SKILL.md'), 'utf8');
            expect(dest).toBe(src);
        }
    });

    it('returns empty when the source dir does not exist', () => {
        expect(seedSkills(join(targetRoot, 'nonexistent'), targetRoot)).toEqual([]);
    });
});
