import { existsSync, readFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';

export interface SecretsStore {
    get(name: string): string | undefined;
    has(name: string): boolean;
    values(): string[];
    rescan(): void;
}

export function defaultSecretsPath(): string {
    const env = process.env.FABRITORIO_SECRETS_FILE;
    if (env && env.length > 0) return resolve(env);
    return join(homedir(), '.fabritorio', 'secrets.env');
}

export function createSecretsStore(opts?: { path?: string }): SecretsStore {
    const path = opts?.path ? resolve(opts.path) : defaultSecretsPath();
    let byName = new Map<string, string>();
    const scan = () => {
        const next = new Map<string, string>();
        if (existsSync(path)) {
            try {
                chmodSync(path, 0o600);
            } catch {
                /* ignore */
            }
            try {
                const raw = readFileSync(path, 'utf8');
                for (const [k, v] of Object.entries(parseDotenv(raw))) {
                    next.set(k, v);
                }
            } catch {
                // unreadable file → empty store, no throw (same tolerance as
                // SkillRegistry's per-entry try/catch).
            }
        }
        byName = next;
    };
    scan();
    return {
        get: (name) => byName.get(name),
        has: (name) => byName.has(name),
        values: () => Array.from(byName.values()),
        rescan: scan,
    };
}
