import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import matter from 'gray-matter';

export interface SkillResource {
    name: string;
    path: string;
}

export interface Skill {
    name: string;
    description: string;
    path: string;
    skill_md_path: string;
    body: string;
    source_root: string;
    resources: SkillResource[];
    allowed_tools?: string[];
}

export interface SkillSummary {
    name: string;
    description: string;
    path: string;
    source_root: string;
    resources: string[];
}

export interface SkillDetail {
    skill: Skill;
    raw: string;
}

export interface SkillRegistry {
    list(): SkillSummary[];
    get(name: string): Skill | undefined;
    read(name: string): SkillDetail | undefined;
    save(name: string, content: string): SkillDetail;
    rescan(): void;
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSkillName(name: string): boolean {
    return SKILL_NAME_RE.test(name) && name.length <= 64;
}

export function defaultSkillRoots(): string[] {
    const env = process.env.FABRITORIO_SKILL_ROOTS;
    if (env && env.length > 0) {
        return env
            .split(':')
            .map((r) => r.trim())
            .filter(Boolean)
            .map((r) => resolve(r));
    }
    return [join(homedir(), '.fabritorio', 'skills')];
}

export function createSkillRegistry(roots: string[] = defaultSkillRoots()): SkillRegistry {
    let byName = new Map<string, Skill>();
    const scan = () => {
        const next = new Map<string, Skill>();
        for (const rawRoot of roots) {
            const root = resolve(rawRoot);
            if (!existsSync(root)) continue;
            let entries: string[];
            try {
                entries = readdirSync(root);
            } catch {
                continue;
            }
            for (const entry of entries) {
                const skillDir = join(root, entry);
                try {
                    if (!statSync(skillDir).isDirectory()) continue;
                } catch {
                    continue;
                }
                const skillMdPath = join(skillDir, 'SKILL.md');
                if (!existsSync(skillMdPath)) continue;
                try {
                    const skill = loadSkill(skillDir, skillMdPath, root);
                    if (!next.has(skill.name)) {
                        next.set(skill.name, skill);
                    }
                } catch {
                    // ignore unreadable / malformed SKILL.md files
                }
            }
        }
        byName = next;
    };
    scan();
    return {
        list: () => Array.from(byName.values(), toSummary),
        get: (name) => byName.get(name),
        read: (name) => {
            const skill = byName.get(name);
            if (!skill) return undefined;
            try {
                return { skill, raw: readFileSync(skill.skill_md_path, 'utf8') };
            } catch {
                return undefined;
            }
        },
        save: (name, content) => {
            if (!isValidSkillName(name)) {
                throw new Error(`invalid skill name: ${name}`);
            }
            const writableRoot = roots[0];
            if (!writableRoot) {
                throw new Error('no writable skill root configured');
            }
            const root = resolve(writableRoot);
            const skillDir = join(root, name);
            const skillMdPath = join(skillDir, 'SKILL.md');
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(skillMdPath, content, 'utf8');
            scan();
            const skill = loadSkill(skillDir, skillMdPath, root);
            return { skill, raw: content };
        },
        rescan: scan,
    };
}

function loadSkill(skillDir: string, skillMdPath: string, sourceRoot: string): Skill {
    const raw = readFileSync(skillMdPath, 'utf8');
    const parsed = matter(raw);
    const data = (parsed.data ?? {}) as Record<string, unknown>;

    const fmName = typeof data.name === 'string' ? data.name.trim() : '';
    const name = fmName.length > 0 ? fmName : basename(skillDir);
    const description = typeof data.description === 'string' ? data.description : '';

    const allowedToolsRaw = data['allowed-tools'];
    const allowed_tools = Array.isArray(allowedToolsRaw)
        ? allowedToolsRaw.filter((v): v is string => typeof v === 'string')
        : undefined;

    const resources: SkillResource[] = [];
    try {
        for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name !== 'SKILL.md') {
                resources.push({
                    name: entry.name,
                    path: join(skillDir, entry.name),
                });
            }
        }
    } catch {
        // dir unreadable — leave resources empty
    }

    return {
        name,
        description,
        path: skillDir,
        skill_md_path: skillMdPath,
        body: parsed.content.trim(),
        source_root: sourceRoot,
        resources,
        ...(allowed_tools ? { allowed_tools } : {}),
    };
}

function toSummary(skill: Skill): SkillSummary {
    return {
        name: skill.name,
        description: skill.description,
        path: skill.path,
        source_root: skill.source_root,
        resources: skill.resources.map((r) => r.name),
    };
}
