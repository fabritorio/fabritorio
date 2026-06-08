import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { defaultSkillRoots } from '../skills.js';

export const SEED_SKILLS_DIR =
    process.env.FAB_SEED_SKILLS_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'seed-skills');

export function seedSkills(
    sourceDir: string = SEED_SKILLS_DIR,
    targetRoot: string = defaultSkillRoots()[0] ?? '',
): string[] {
    if (!targetRoot || !existsSync(sourceDir)) return [];

    const seeded: string[] = [];
    for (const name of readdirSync(sourceDir)) {
        const src = join(sourceDir, name);
        try {
            if (!statSync(src).isDirectory()) continue;
        } catch {
            continue;
        }
        const dest = join(targetRoot, name);
        if (existsSync(dest)) continue;
        mkdirSync(targetRoot, { recursive: true });
        cpSync(src, dest, { recursive: true });
        seeded.push(name);
    }
    return seeded;
}
