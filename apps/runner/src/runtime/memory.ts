import type { Graph, MemoryNode, Message, Node } from '@fabritorio/types';
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

export interface MemoryHandle {
    nodeId: string;
    read(key: string): unknown;
    write(key: string, value: unknown): void;
    delete(key: string): void;
    snapshot(): Record<string, unknown>;
}

export interface MemoryRegistry {
    resolve(node: MemoryNode): MemoryHandle;
    get(nodeId: string): MemoryHandle | undefined;
    list(): MemoryHandle[];
}

export function createInMemoryHandle(nodeId: string): MemoryHandle {
    const store = new Map<string, unknown>();
    return {
        nodeId,
        read(key) {
            return store.get(key);
        },
        write(key, value) {
            store.set(key, value);
        },
        delete(key) {
            store.delete(key);
        },
        snapshot() {
            return Object.fromEntries(store);
        },
    };
}

export function createFileBackedHandle(nodeId: string, dir: string): MemoryHandle {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${nodeId}.json`);
    const tmpPath = `${path}.tmp`;
    const store = new Map<string, unknown>();

    if (existsSync(path)) {
        try {
            const raw = readFileSync(path, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                    store.set(k, v);
                }
            }
        } catch {
            // Corrupt file — start fresh; next write will overwrite.
        }
    }

    function persist(): void {
        const payload = JSON.stringify(Object.fromEntries(store), null, 2);
        writeFileSync(tmpPath, payload, 'utf8');
        renameSync(tmpPath, path);
    }

    return {
        nodeId,
        read(key) {
            return store.get(key);
        },
        write(key, value) {
            store.set(key, value);
            persist();
        },
        delete(key) {
            store.delete(key);
            persist();
        },
        snapshot() {
            return Object.fromEntries(store);
        },
    };
}

export const MARKDOWN_FILE_EXT = '.md';

export function markdownMemoryPath(dir: string, nodeId: string): string {
    return join(resolve(dir), `${nodeId}${MARKDOWN_FILE_EXT}`);
}

export function readMarkdownMemoryFile(dir: string, nodeId: string): string | undefined {
    const path = markdownMemoryPath(dir, nodeId);
    if (!existsSync(path)) return undefined;
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return undefined;
    }
}

export function writeMarkdownMemoryFile(dir: string, nodeId: string, content: string): void {
    const path = markdownMemoryPath(dir, nodeId);
    mkdirSync(resolve(dir), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, path);
}

export function deleteMarkdownMemoryFile(dir: string, nodeId: string): void {
    const path = markdownMemoryPath(dir, nodeId);
    if (existsSync(path)) unlinkSync(path);
}

export function createMarkdownFileBackedHandle(nodeId: string, dir: string): MemoryHandle {
    mkdirSync(resolve(dir), { recursive: true });
    return {
        nodeId,
        read(key) {
            if (key !== 'content') return undefined;
            return readMarkdownMemoryFile(dir, nodeId);
        },
        write(key, value) {
            if (key !== 'content') {
                throw new Error(
                    `markdown memory ${nodeId}: only "content" is writable (got "${key}")`,
                );
            }
            if (typeof value !== 'string') {
                throw new Error(
                    `markdown memory ${nodeId}: content must be a string (got ${typeof value})`,
                );
            }
            writeMarkdownMemoryFile(dir, nodeId, value);
        },
        delete(key) {
            if (key !== 'content') {
                throw new Error(
                    `markdown memory ${nodeId}: only "content" is deletable (got "${key}")`,
                );
            }
            deleteMarkdownMemoryFile(dir, nodeId);
        },
        snapshot() {
            const c = readMarkdownMemoryFile(dir, nodeId);
            return c === undefined ? {} : { content: c };
        },
    };
}

export function resolveMemoryDir(dir?: string): string {
    if (dir) return resolve(dir);
    const fromEnv = process.env.FABRITORIO_MEMORY_DIR;
    if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
    return join(homedir(), '.fabritorio', 'memory');
}

export function isSafeMemoryNodeId(nodeId: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(nodeId) && nodeId !== '.' && nodeId !== '..';
}

export function migrateMemoryNode(node: MemoryNode): { node: MemoryNode; migrated: boolean } {
    const legacy = node as MemoryNode & { purpose?: 'session' | 'context' | 'scratchpad' };
    const hasNewFields =
        node.storage_kind !== undefined &&
        node.handling !== undefined &&
        node.tool_access !== undefined;
    if (hasNewFields && legacy.purpose === undefined) {
        return { node, migrated: false };
    }

    const purpose = legacy.purpose ?? 'session';
    let storage_kind: MemoryNode['storage_kind'];
    let handling: MemoryNode['handling'];
    let tool_access: MemoryNode['tool_access'];
    switch (purpose) {
        case 'context':
            storage_kind = 'static_string';
            handling = 'always_inject';
            tool_access = 'none';
            break;
        case 'scratchpad':
            storage_kind = 'markdown';
            handling = 'always_inject';
            tool_access = 'read_write';
            break;
        case 'session':
        default:
            storage_kind = 'kv';
            handling = 'full_history';
            tool_access = 'none';
            break;
    }
    const { purpose: _drop, ...rest } = legacy;
    void _drop;
    const next: MemoryNode = {
        ...rest,
        storage_kind: node.storage_kind ?? storage_kind,
        handling: node.handling ?? handling,
        tool_access: node.tool_access ?? tool_access,
    };
    return { node: next, migrated: true };
}

export function migrateMemoryNodesInGraph(graph: Graph): Graph {
    let changed = false;
    const nodes: Node[] = graph.nodes.map((n): Node => {
        if (n.type !== 'memory') return n;
        const result = migrateMemoryNode(n as MemoryNode);
        if (result.migrated) changed = true;
        return result.node as Node;
    });
    if (!changed) return graph;
    return { ...graph, nodes };
}

export function partitionMemoryNodes(memoryNodes: MemoryNode[]): {
    historyMemory: MemoryNode | undefined;
    injectedMemories: MemoryNode[];
    toolMemory: MemoryNode | undefined;
} {
    const historyMemory = memoryNodes.find(
        (n) =>
            n.handling === 'full_history' ||
            n.handling === 'last_n' ||
            n.handling === 'last_within_tokens',
    );
    const injectedMemories = memoryNodes.filter((n) => n.handling === 'always_inject');
    const toolMemory = memoryNodes.find(
        (n) => n.storage_kind === 'markdown' && n.tool_access !== 'none',
    );
    return { historyMemory, injectedMemories, toolMemory };
}

export const LAST_N_DEFAULT = 20;

export function windowMessagesByTurns(messages: readonly Message[], n: number): Message[] {
    if (n <= 0) return [];
    let userCount = 0;
    let cutIndex = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'user') {
            userCount += 1;
            if (userCount === n) {
                cutIndex = i;
                return messages.slice(cutIndex);
            }
        }
    }
    return messages.slice(0);
}

export const LAST_WITHIN_TOKENS_DEFAULT = 8192;

const PER_MESSAGE_TOKEN_OVERHEAD = 4;

export function estimateTokens(message: Message): number {
    let chars = message.role.length + (message.content?.length ?? 0);
    if (message.name) chars += message.name.length;
    if (message.tool_call_id) chars += message.tool_call_id.length;
    if (message.tool_calls) {
        for (const call of message.tool_calls) {
            chars += call.id.length + call.name.length;
            chars += JSON.stringify(call.arguments).length;
        }
    }
    return Math.ceil(chars / 4) + PER_MESSAGE_TOKEN_OVERHEAD;
}

export function windowMessagesByTokenBudget(
    messages: readonly Message[],
    budget: number,
    estimator: (m: Message) => number = estimateTokens,
): Message[] {
    if (messages.length === 0) return [];

    let acceptedStart = messages.length;
    let acceptedTokens = 0;
    let pendingStart = messages.length;
    let pendingTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m) continue;
        pendingStart = i;
        pendingTokens += estimator(m);
        if (m.role !== 'user') continue;
        const isFirstTurn = acceptedStart === messages.length;
        if (isFirstTurn || acceptedTokens + pendingTokens <= budget) {
            acceptedStart = pendingStart;
            acceptedTokens += pendingTokens;
            pendingTokens = 0;
        } else {
            break;
        }
    }

    if (acceptedStart === messages.length) return messages.slice(0);
    return messages.slice(acceptedStart);
}

export const MARKDOWN_CONTENT_KEY = 'content';

export function readMarkdownContent(handle: MemoryHandle): string {
    const raw = handle.read(MARKDOWN_CONTENT_KEY);
    return typeof raw === 'string' ? raw : '';
}

export function writeMarkdownContent(handle: MemoryHandle, text: string): void {
    handle.write(MARKDOWN_CONTENT_KEY, text);
}

export function renderInjectedMemoryBlock(
    memoryNodes: MemoryNode[],
    resolveHandle: (node: MemoryNode) => MemoryHandle | undefined,
): string {
    const parts: string[] = [];
    for (const n of memoryNodes) {
        if (n.handling !== 'always_inject') continue;
        if (n.storage_kind === 'static_string') {
            const content = (n.content ?? '').trim();
            if (content.length > 0) parts.push(content);
            continue;
        }
        if (n.storage_kind === 'markdown') {
            const handle = resolveHandle(n);
            if (!handle) continue;
            const content = readMarkdownContent(handle).trim();
            if (content.length === 0) continue;
            if (n.tool_access !== 'none') {
                parts.push(`## Scratchpad (editable via memory_read / memory_write)\n\n${content}`);
            } else {
                parts.push(content);
            }
        }
    }
    return parts.join('\n\n');
}

function memoryHandleSignature(node: MemoryNode): string {
    if (node.storage === 'local_storage') {
        return `local_storage:${node.storage_kind === 'markdown' ? 'markdown' : 'json'}`;
    }
    return `${node.storage}`;
}

export function createMemoryRegistry(opts: { localStorageDir?: string } = {}): MemoryRegistry {
    const byId = new Map<string, { handle: MemoryHandle; signature: string }>();
    return {
        resolve(node) {
            const signature = memoryHandleSignature(node);
            const existing = byId.get(node.id);
            if (existing && existing.signature === signature) return existing.handle;
            let handle: MemoryHandle;
            if (node.storage === 'in_memory') {
                handle = createInMemoryHandle(node.id);
            } else if (node.storage === 'local_storage') {
                const dir = resolveMemoryDir(opts.localStorageDir);
                handle =
                    node.storage_kind === 'markdown'
                        ? createMarkdownFileBackedHandle(node.id, dir)
                        : createFileBackedHandle(node.id, dir);
            } else {
                throw new Error(
                    `memory ${node.id}: unsupported storage "${(node as { storage?: unknown }).storage}"`,
                );
            }
            byId.set(node.id, { handle, signature });
            return handle;
        },
        get(id) {
            return byId.get(id)?.handle;
        },
        list() {
            return [...byId.values()].map((e) => e.handle);
        },
    };
}
