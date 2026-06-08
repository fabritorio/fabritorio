import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ConversationLabelStore {
    get(graphId: string, agentId: string, convId: string): string | undefined;
    getAllForGraph(graphId: string): Record<string, string>;
    set(graphId: string, agentId: string, convId: string, label: string): void;
    delete(graphId: string, agentId: string, convId: string): void;
    deleteGraph(graphId: string): void;
}

export interface ConversationLabelStoreOptions {
    dir?: string;
}

export function resolveConversationsDir(dir?: string): string {
    if (dir) return resolve(dir);
    const fromEnv = process.env.FABRITORIO_CONVERSATIONS_DIR;
    if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
    return join(homedir(), '.fabritorio', 'conversations');
}

function isSafeGraphId(graphId: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(graphId) && graphId !== '.' && graphId !== '..';
}

function keyFor(agentId: string, convId: string): string {
    return `${agentId}:${convId}`;
}

export function createConversationLabelStore(
    opts: ConversationLabelStoreOptions = {},
): ConversationLabelStore {
    const dir = resolveConversationsDir(opts.dir);
    const byGraph = new Map<string, Map<string, string>>();

    function pathFor(graphId: string): string {
        return join(dir, `${graphId}.json`);
    }

    function load(graphId: string): Map<string, string> {
        const cached = byGraph.get(graphId);
        if (cached) return cached;
        const map = new Map<string, string>();
        const path = pathFor(graphId);
        if (existsSync(path)) {
            try {
                const parsed = JSON.parse(readFileSync(path, 'utf8'));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                        if (typeof v === 'string') map.set(k, v);
                    }
                }
            } catch {
                // Corrupt file — start empty; next write overwrites it.
            }
        }
        byGraph.set(graphId, map);
        return map;
    }

    function persist(graphId: string, map: Map<string, string>): void {
        const path = pathFor(graphId);
        const tmpPath = `${path}.tmp`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
        renameSync(tmpPath, path);
    }

    return {
        get(graphId, agentId, convId) {
            if (!isSafeGraphId(graphId)) return undefined;
            return load(graphId).get(keyFor(agentId, convId));
        },
        getAllForGraph(graphId) {
            if (!isSafeGraphId(graphId)) return {};
            return Object.fromEntries(load(graphId));
        },
        set(graphId, agentId, convId, label) {
            if (!isSafeGraphId(graphId)) return;
            const map = load(graphId);
            const trimmed = label.trim();
            const key = keyFor(agentId, convId);
            if (trimmed.length === 0) {
                if (!map.has(key)) return;
                map.delete(key);
            } else {
                if (map.get(key) === trimmed) return;
                map.set(key, trimmed);
            }
            persist(graphId, map);
        },
        delete(graphId, agentId, convId) {
            if (!isSafeGraphId(graphId)) return;
            const map = load(graphId);
            const key = keyFor(agentId, convId);
            if (!map.has(key)) return;
            map.delete(key);
            persist(graphId, map);
        },
        deleteGraph(graphId) {
            if (!isSafeGraphId(graphId)) return;
            byGraph.delete(graphId);
            const path = pathFor(graphId);
            if (existsSync(path)) unlinkSync(path);
        },
    };
}
