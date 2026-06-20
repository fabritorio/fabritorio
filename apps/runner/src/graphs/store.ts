import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Graph, GraphKind } from '@fabritorio/types';
import { migrateMemoryNodesInGraph } from '../runtime/memory.js';

export interface GraphStore {
    create(graph: Omit<Graph, 'id' | 'created_at' | 'updated_at'>): Promise<Graph>;
    update(
        id: string,
        graph: Omit<Graph, 'id' | 'created_at' | 'updated_at'>,
    ): Promise<Graph | null>;
    get(id: string): Promise<Graph | undefined>;
    delete(id: string): Promise<boolean>;
    list(filter?: { kind?: GraphKind }): Promise<Graph[]>;
    seed(id: string, graph: Omit<Graph, 'id' | 'created_at' | 'updated_at'>): Promise<Graph>;
}

export interface GraphStoreOptions {
    dir?: string;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidGraphId(id: string): boolean {
    return ID_PATTERN.test(id);
}

export function resolveGraphsDir(dir?: string): string {
    if (dir) return resolve(dir);
    const fromEnv = process.env.FABRITORIO_GRAPHS_DIR;
    if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
    return join(homedir(), '.fabritorio', 'graphs');
}

const KNOWN_KINDS = new Set(['toolpack', 'skillpack', 'handler', 'l1', 'l2']);

function isGraph(value: unknown): value is Graph {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj.kind !== 'string' || !KNOWN_KINDS.has(obj.kind)) return false;
    if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return false;
    return true;
}

export function createGraphStore(opts: GraphStoreOptions = {}): GraphStore {
    const dir = resolveGraphsDir(opts.dir);

    async function ensureDir(): Promise<void> {
        await mkdir(dir, { recursive: true });
    }

    function pathFor(id: string): string {
        return join(dir, `${id}.json`);
    }

    async function readGraphFile(id: string): Promise<Graph | null> {
        let raw: string;
        try {
            raw = await readFile(pathFor(id), 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
        if (!isGraph(parsed)) return null;
        return migrateMemoryNodesInGraph({ ...parsed, id });
    }

    async function writeGraphFile(graph: Graph): Promise<void> {
        await ensureDir();
        const finalPath = pathFor(graph.id!);
        const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
        const payload = JSON.stringify(graph, null, 2);
        try {
            await writeFile(tmpPath, payload, 'utf8');
            await rename(tmpPath, finalPath);
        } catch (err) {
            try {
                await rm(tmpPath, { force: true });
            } catch {
                // best-effort
            }
            throw err;
        }
    }

    return {
        async create(graph) {
            const now = new Date().toISOString();
            const id = randomUUID();
            const rec: Graph = {
                ...graph,
                id,
                created_at: now,
                updated_at: now,
            };
            await writeGraphFile(rec);
            return rec;
        },

        async update(id, graph) {
            if (!isValidGraphId(id)) return null;
            const existing = await readGraphFile(id);
            if (!existing) return null;
            const now = new Date().toISOString();
            const rec: Graph = {
                ...graph,
                id,
                created_at: existing.created_at ?? now,
                updated_at: now,
            };
            await writeGraphFile(rec);
            return rec;
        },

        async get(id) {
            if (!isValidGraphId(id)) return undefined;
            return (await readGraphFile(id)) ?? undefined;
        },

        async delete(id) {
            if (!isValidGraphId(id)) return false;
            try {
                await rm(pathFor(id));
                return true;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw err;
            }
        },

        async seed(id, graph) {
            if (!isValidGraphId(id)) {
                throw new Error(`seed: invalid id ${id}`);
            }
            const existing = await readGraphFile(id);
            if (existing) return existing;
            const now = new Date().toISOString();
            const rec: Graph = {
                ...graph,
                id,
                created_at: now,
                updated_at: now,
            };
            await writeGraphFile(rec);
            return rec;
        },

        async list(filter) {
            try {
                const entries = await readdir(dir, { withFileTypes: true });
                const graphs: Graph[] = [];
                for (const entry of entries) {
                    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                    const id = entry.name.slice(0, -'.json'.length);
                    if (!isValidGraphId(id)) continue;
                    const g = await readGraphFile(id);
                    if (!g) continue;
                    if (filter?.kind && g.kind !== filter.kind) continue;
                    graphs.push(g);
                }
                graphs.sort((a, b) => {
                    const aT = a.updated_at ?? '';
                    const bT = b.updated_at ?? '';
                    return aT < bT ? 1 : aT > bT ? -1 : 0;
                });
                return graphs;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw err;
            }
        },
    };
}
