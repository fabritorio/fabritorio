import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
    DispatchEvent,
    Edge,
    Graph,
    GraphKind,
    ObservabilityEvent,
    OutputEmittedEvent,
} from '@fabritorio/types';
import { instantiateLibraryGraph } from '../graphs/instantiate.js';
import { withGraphLock } from '../graphs/lock.js';
import { applyGraphEdit, createGraphPersist, type GraphDraft } from '../graphs/persist.js';
import { isValidGraphId, type GraphStore } from '../graphs/store.js';
import { childDispatch, newDispatch } from './dispatch.js';
import type { EventBus } from './event-bus.js';
import type { GraphRuntimeRegistry } from './graph-runtime.js';
import { executeBash, truncateTail } from './bash-exec.js';
import { WEB_FETCH_SPEC } from './web-fetch-tool.js';
import { WEB_SEARCH_SPEC } from './web-search-tool.js';
import { type MemoryHandle, readMarkdownContent, writeMarkdownContent } from './memory.js';
import { getCurrentTimeTool, type Tool, type ToolResult, type ToolSpec } from './tools.js';

const READ_FILE_SPEC: ToolSpec = {
    name: 'read_file',
    description:
        'Read a UTF-8 text file from the wired Workspace. Use a path relative to the workspace root.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Relative file path within the workspace.',
            },
        },
        required: ['path'],
        additionalProperties: false,
    },
};

const WRITE_FILE_SPEC: ToolSpec = {
    name: 'write_file',
    description:
        'Write a UTF-8 text file under the wired Workspace, creating parent directories as needed. Overwrites if the file already exists. Requires the Workspace to be wired with read-write permissions.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Relative file path within the workspace.',
            },
            content: {
                type: 'string',
                description: 'Full UTF-8 contents to write.',
            },
        },
        required: ['path', 'content'],
        additionalProperties: false,
    },
};

const EDIT_FILE_SPEC: ToolSpec = {
    name: 'edit_file',
    description:
        'Replace a unique snippet of text in an existing file under the wired Workspace. The old_text must occur exactly once. Requires the Workspace to be wired with read-write permissions.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Relative file path within the workspace.',
            },
            old_text: {
                type: 'string',
                description: 'Exact text to replace. Must match a single occurrence.',
            },
            new_text: {
                type: 'string',
                description: 'Replacement text.',
            },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
    },
};

const BASH_DEFAULT_TIMEOUT_SECONDS = 30;
const BASH_MAX_TIMEOUT_SECONDS = 300;
const BASH_MAX_OUTPUT_LINES = 500;
const BASH_MAX_OUTPUT_BYTES = 32 * 1024;

const BASH_SPEC: ToolSpec = {
    name: 'bash',
    description:
        'Execute a bash command inside the wired Workspace. Working directory is the workspace root by default, or a relative subdirectory if `cwd` is provided. Combined stdout+stderr is returned (last ~500 lines / 32KB kept on overflow). Default timeout 30s, max 300s. Requires the Workspace to be wired with read-write permissions.',
    parameters: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Bash command to execute via `bash -c`.',
            },
            cwd: {
                type: 'string',
                description:
                    'Optional working directory, relative to the workspace root. Defaults to the workspace root.',
            },
            timeout_seconds: {
                type: 'number',
                description: 'Optional hard timeout in seconds. Defaults to 30, capped at 300.',
            },
        },
        required: ['command'],
        additionalProperties: false,
    },
};

const MEMORY_READ_SPEC: ToolSpec = {
    name: 'memory_read',
    description:
        "Read the agent's scratchpad markdown — long-lived notes the agent maintains across Dispatches. Returns the full current contents (may be empty on a fresh scratchpad). Pair with `memory_write` to update.",
    parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
    },
};

const MEMORY_WRITE_SPEC: ToolSpec = {
    name: 'memory_write',
    description:
        "Replace the agent's scratchpad markdown with new contents. Use this to record what's worth remembering for future Dispatches. The replacement is atomic — to amend rather than rewrite, call `memory_read` first, edit the returned text in-process, then write the merged result.",
    parameters: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description: 'Full markdown contents to store as the new scratchpad.',
            },
        },
        required: ['content'],
        additionalProperties: false,
    },
};

const KNOWN_GRAPH_KINDS: ReadonlySet<GraphKind> = new Set<GraphKind>([
    'toolpack',
    'skillpack',
    'handler',
    'l1',
    'l2',
]);

const READ_CANVAS_SPEC: ToolSpec = {
    name: 'read_canvas',
    description:
        "Return the user's \"active canvas\" — the L2 orchestration graph that contains the NativeAgent referencing this agent's L1. Returns the full Graph JSON (id, kind, name, description, nodes, edges, ...). The `nodes` field shows the canvas's top-level structure: channels, NativeAgents (each with `l1_graph_id`), triggers, memories. To drill into an agent's body, call `read_graph` with the `l1_graph_id` from a NativeAgent node; to drill further (toolpacks/skillpacks/handlers), `read_graph` the `ref_id`s from inside that L1. Errors with a clear message when this agent has no parent L2 (e.g. running standalone via DebugGateway).",
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const READ_GRAPH_SPEC: ToolSpec = {
    name: 'read_graph',
    description:
        'Read a saved graph by id. Returns the full Graph JSON (id, kind, name, description, library, nodes, edges, timestamps) so the caller can inspect or mutate it.',
    parameters: {
        type: 'object',
        properties: {
            id: {
                type: 'string',
                description: 'UUID of the graph to read.',
            },
        },
        required: ['id'],
        additionalProperties: false,
    },
};

const CREATE_GRAPH_SPEC: ToolSpec = {
    name: 'create_graph',
    description:
        'Create a new graph in the runner. Pass `kind` (toolpack, skillpack, handler, l1, l2) and optional `name`, `description`, `nodes`, `edges`. Nodes/edges may be omitted to reserve an id and fill in via `edit_graph` later. Node positions are computed automatically — you do not need to supply them. **Node and edge ids are minted server-side**: omit `id` on each node/edge to let the runner mint a canonical `<prefix>-<short-uuid>` (e.g. `gateway-x3k9p2`). If you do supply ids (e.g. to wire edges to nodes in the same payload), the runner rewrites any that collide with existing graphs or are duplicated within the payload; the response includes a `remap` of old→new ids so you can resolve placeholder references. Returns `{ id, graph, remap }`.',
    parameters: {
        type: 'object',
        properties: {
            kind: {
                type: 'string',
                description: 'Graph kind. One of: toolpack, skillpack, handler, l1, l2.',
                enum: ['toolpack', 'skillpack', 'handler', 'l1', 'l2'],
            },
            name: { type: 'string', description: 'Optional human-readable name.' },
            description: {
                type: 'string',
                description: 'Optional human-readable description.',
            },
            nodes: {
                type: 'array',
                description:
                    'Optional initial nodes. Defaults to []. Each node may omit `position` — auto-layout fills it in.',
            },
            edges: {
                type: 'array',
                description: 'Optional initial edges. Defaults to [].',
            },
        },
        required: ['kind'],
        additionalProperties: false,
    },
};

const EDIT_GRAPH_SPEC: ToolSpec = {
    name: 'edit_graph',
    description:
        "Replace an existing graph's contents. Pass `id` (the graph to edit) and `graph` (the full new payload). The graph kind must match the existing kind; the library flag is immutable. Auto-layout fills in missing node positions; nodes that already have a position keep it. **Node and edge ids are minted server-side**: nodes/edges already in the graph keep their ids; new entries can omit `id` and the runner mints `<prefix>-<short-uuid>` for them. Supplied ids that collide with other graphs or duplicate within the payload are rewritten; the response includes a `remap` of old→new ids. Mutating a loaded graph triggers a runtime reload. Returns `{ graph, remap }`.",
    parameters: {
        type: 'object',
        properties: {
            id: {
                type: 'string',
                description: 'UUID of the graph to edit.',
            },
            graph: {
                type: 'object',
                description:
                    'Full Graph payload — kind, nodes, edges, plus optional name/description. The `id` field inside `graph`, if present, must equal the path id.',
            },
        },
        required: ['id', 'graph'],
        additionalProperties: false,
    },
};

const ASK_AGENT_BRIEF_PARAM = {
    type: 'string',
    description: 'Message content for the callee.',
} as const;
const ASK_AGENT_INHERIT_SESSION_PARAM = {
    type: 'boolean',
    description:
        "If true, callee shares the caller's session source. Default false (callee gets a fresh ephemeral source).",
} as const;
const ASK_AGENT_TIMEOUT_PARAM = {
    type: 'number',
    description:
        'Optional timeout in milliseconds. Defaults to 60000. The call rejects with an error result on timeout.',
} as const;

const ASK_AGENT_SPEC: ToolSpec = {
    name: 'ask_agent',
    description:
        "Synchronously call another agent reachable via an outgoing edge from this agent. Awaits the callee's Output and returns its content as the tool result. Gated by edge topology: the caller's agent node must have an outgoing edge whose target is the named agent node id, otherwise the call errors. Use `inherit_session: true` to make the callee participate in the caller's session (shared `dispatch.source`); the default false hands the callee a fresh ephemeral source so its Memory thread is isolated.",
    parameters: {
        type: 'object',
        properties: {
            target_agent_id: {
                type: 'string',
                description:
                    "Node id of the target agent. Must be the destination of an outgoing edge from the calling agent's node.",
            },
            brief: ASK_AGENT_BRIEF_PARAM,
            inherit_session: ASK_AGENT_INHERIT_SESSION_PARAM,
            timeout_ms: ASK_AGENT_TIMEOUT_PARAM,
        },
        required: ['target_agent_id', 'brief'],
        additionalProperties: false,
    },
};

const PRIOR_TURNS_SPEC: ToolSpec = {
    name: 'prior_turns',
    description:
        "Return the most recent root-Dispatch turns of the current session (defined by the in-flight Dispatch's `source`). Each turn pairs the inbound user message with the agent's reply, when one was emitted. Returns a JSON array of `{eventId, timestamp, role, content}` entries, oldest first — typical use is to feed it back into the model context to recover prior conversation. Excludes the in-flight turn so the agent doesn't see its own current question echoed back.",
    parameters: {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description:
                    'Max number of *turns* (user+assistant pairs) to return, counted from most recent. Defaults to 10. A turn with no reply yet contributes only its user entry.',
            },
        },
        required: [],
        additionalProperties: false,
    },
};

const INSTANTIATE_COMPOSITE_SPEC: ToolSpec = {
    name: 'instantiate_composite',
    description:
        "Stamp a library composite template into a fresh runtime graph. Pass `template_id` (the id of an existing graph with `library: true`). The template carries its own positions, so no position argument is needed; call `edit_graph` afterwards to relocate. Returns `{id, remap}` where `id` is the new graph's id and `remap` maps each template graph id (root and any nested library templates walked into) to its freshly-persisted copy id, so the caller can wire edges or refs to the freshly-minted graphs.",
    parameters: {
        type: 'object',
        properties: {
            template_id: {
                type: 'string',
                description: 'UUID of the library template graph to instantiate.',
            },
        },
        required: ['template_id'],
        additionalProperties: false,
    },
};

const LIST_DIRECTORY_SPEC: ToolSpec = {
    name: 'list_directory',
    description:
        'List the immediate entries of a directory under the wired Workspace. Returns one entry per line; directories are suffixed with `/`. Defaults to the workspace root when path is omitted.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description:
                    'Relative directory path within the workspace. Defaults to the workspace root.',
            },
        },
        required: [],
        additionalProperties: false,
    },
};

export const BUILTIN_TOOL_SPECS: ToolSpec[] = [
    READ_FILE_SPEC,
    WRITE_FILE_SPEC,
    EDIT_FILE_SPEC,
    LIST_DIRECTORY_SPEC,
    BASH_SPEC,
    WEB_FETCH_SPEC,
    WEB_SEARCH_SPEC,
    MEMORY_READ_SPEC,
    MEMORY_WRITE_SPEC,
    READ_CANVAS_SPEC,
    READ_GRAPH_SPEC,
    CREATE_GRAPH_SPEC,
    EDIT_GRAPH_SPEC,
    INSTANTIATE_COMPOSITE_SPEC,
    ASK_AGENT_SPEC,
    PRIOR_TURNS_SPEC,
    getCurrentTimeTool.spec,
];

export interface WorkspaceBinding {
    path: string;
    permissions: 'read' | 'read-write';
}

function resolveInside(
    root: string,
    candidate: string,
): { ok: true; path: string } | { ok: false; reason: string } {
    if (!candidate) return { ok: false, reason: 'missing required argument: path' };
    const resolvedRoot = resolve(root);
    const target = isAbsolute(candidate) ? resolve(candidate) : resolve(resolvedRoot, candidate);
    const rel = relative(resolvedRoot, target);
    if (rel.startsWith('..') || (isAbsolute(rel) && rel !== '')) {
        return { ok: false, reason: `path escapes workspace: ${candidate}` };
    }
    if (rel.split(sep).some((seg) => seg === '..')) {
        return { ok: false, reason: `path escapes workspace: ${candidate}` };
    }
    return { ok: true, path: target };
}

export function createReadFileTool(workspace: WorkspaceBinding | null): Tool {
    const root = workspace ? resolve(workspace.path) : resolve(process.cwd());
    return {
        spec: READ_FILE_SPEC,
        handler: async (args) => {
            const raw = typeof args.path === 'string' ? args.path : '';
            const resolved = resolveInside(root, raw);
            if (!resolved.ok) {
                return { stdout: '', stderr: resolved.reason, exit_code: 1 };
            }
            try {
                const s = await stat(resolved.path);
                if (!s.isFile()) {
                    return { stdout: '', stderr: `not a file: ${raw}`, exit_code: 1 };
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `stat failed: ${msg}`, exit_code: 1 };
            }
            try {
                const content = await readFile(resolved.path, 'utf8');
                return { stdout: content, stderr: '', exit_code: 0 };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `read failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

function requireWritableRoot(
    workspace: WorkspaceBinding | null,
    toolName: string,
): { ok: true; root: string } | { ok: false; reason: string } {
    if (!workspace) {
        return {
            ok: false,
            reason: `${toolName} requires a Workspace wired to the Handler`,
        };
    }
    if (workspace.permissions !== 'read-write') {
        return {
            ok: false,
            reason: `${toolName} requires read-write permissions on the wired Workspace`,
        };
    }
    return { ok: true, root: resolve(workspace.path) };
}

export function createWriteFileTool(workspace: WorkspaceBinding | null): Tool {
    return {
        spec: WRITE_FILE_SPEC,
        handler: async (args) => {
            const root = requireWritableRoot(workspace, 'write_file');
            if (!root.ok) {
                return { stdout: '', stderr: root.reason, exit_code: 1 };
            }
            const rawPath = typeof args.path === 'string' ? args.path : '';
            const content = typeof args.content === 'string' ? args.content : null;
            if (content === null) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: content',
                    exit_code: 1,
                };
            }
            const resolved = resolveInside(root.root, rawPath);
            if (!resolved.ok) {
                return { stdout: '', stderr: resolved.reason, exit_code: 1 };
            }
            try {
                const s = await stat(resolved.path);
                if (s.isDirectory()) {
                    return {
                        stdout: '',
                        stderr: `target is a directory: ${rawPath}`,
                        exit_code: 1,
                    };
                }
            } catch {
                // missing target is fine — we'll create it
            }
            try {
                await mkdir(dirname(resolved.path), { recursive: true });
                await writeFile(resolved.path, content, 'utf8');
                const bytes = Buffer.byteLength(content, 'utf8');
                return {
                    stdout: `wrote ${bytes} bytes to ${rawPath}`,
                    stderr: '',
                    exit_code: 0,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `write failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

export function createEditFileTool(workspace: WorkspaceBinding | null): Tool {
    return {
        spec: EDIT_FILE_SPEC,
        handler: async (args) => {
            const root = requireWritableRoot(workspace, 'edit_file');
            if (!root.ok) {
                return { stdout: '', stderr: root.reason, exit_code: 1 };
            }
            const rawPath = typeof args.path === 'string' ? args.path : '';
            const oldText = typeof args.old_text === 'string' ? args.old_text : null;
            const newText = typeof args.new_text === 'string' ? args.new_text : null;
            if (oldText === null) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: old_text',
                    exit_code: 1,
                };
            }
            if (newText === null) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: new_text',
                    exit_code: 1,
                };
            }
            if (oldText === '') {
                return {
                    stdout: '',
                    stderr: 'old_text must not be empty',
                    exit_code: 1,
                };
            }
            const resolved = resolveInside(root.root, rawPath);
            if (!resolved.ok) {
                return { stdout: '', stderr: resolved.reason, exit_code: 1 };
            }
            let original: string;
            try {
                const s = await stat(resolved.path);
                if (!s.isFile()) {
                    return {
                        stdout: '',
                        stderr: `not a file: ${rawPath}`,
                        exit_code: 1,
                    };
                }
                original = await readFile(resolved.path, 'utf8');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `read failed: ${msg}`, exit_code: 1 };
            }
            const occurrences = original.split(oldText).length - 1;
            if (occurrences === 0) {
                return {
                    stdout: '',
                    stderr: 'old_text not found in file',
                    exit_code: 1,
                };
            }
            if (occurrences > 1) {
                return {
                    stdout: '',
                    stderr: `old_text matched ${occurrences} times — include more surrounding context to make it unique`,
                    exit_code: 1,
                };
            }
            const updated = original.replace(oldText, newText);
            try {
                await writeFile(resolved.path, updated, 'utf8');
                return {
                    stdout: `edited ${rawPath} (1 replacement)`,
                    stderr: '',
                    exit_code: 0,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `write failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

export function bashCommandExecutable(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) return '';
    for (const tok of trimmed.split(/\s+/)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
        return tok;
    }
    return '';
}

export function createBashTool(workspace: WorkspaceBinding | null): Tool {
    return {
        spec: BASH_SPEC,
        argSignature: (args) =>
            bashCommandExecutable(typeof args.command === 'string' ? args.command : ''),
        handler: async (args, ctx) => {
            const root = requireWritableRoot(workspace, 'bash');
            if (!root.ok) {
                return { stdout: '', stderr: root.reason, exit_code: 1 };
            }
            const command = typeof args.command === 'string' ? args.command : '';
            if (!command.trim()) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: command',
                    exit_code: 1,
                };
            }
            const rawCwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : '.';
            const resolved = resolveInside(root.root, rawCwd);
            if (!resolved.ok) {
                return { stdout: '', stderr: resolved.reason, exit_code: 1 };
            }
            try {
                const s = await stat(resolved.path);
                if (!s.isDirectory()) {
                    return {
                        stdout: '',
                        stderr: `cwd is not a directory: ${rawCwd}`,
                        exit_code: 1,
                    };
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `stat cwd failed: ${msg}`, exit_code: 1 };
            }
            const requested =
                typeof args.timeout_seconds === 'number' ? args.timeout_seconds : undefined;
            const timeoutSec =
                requested !== undefined && requested > 0
                    ? Math.min(requested, BASH_MAX_TIMEOUT_SECONDS)
                    : BASH_DEFAULT_TIMEOUT_SECONDS;
            try {
                const result = await executeBash({
                    command,
                    cwd: resolved.path,
                    timeoutMs: timeoutSec * 1000,
                    ...(ctx.signal ? { signal: ctx.signal } : {}),
                });
                const truncation = truncateTail(
                    result.output,
                    BASH_MAX_OUTPUT_LINES,
                    BASH_MAX_OUTPUT_BYTES,
                );
                let stdout = truncation.content;
                if (truncation.note) {
                    stdout = stdout ? `${stdout}\n\n${truncation.note}` : truncation.note;
                }
                if (result.aborted) {
                    const note = '[Command cancelled by user]';
                    stdout = stdout ? `${stdout}\n\n${note}` : note;
                    return { stdout, stderr: '', exit_code: 1 };
                }
                if (result.timedOut) {
                    const note = `[Command timed out after ${timeoutSec}s]`;
                    stdout = stdout ? `${stdout}\n\n${note}` : note;
                    return { stdout, stderr: '', exit_code: 124 };
                }
                return {
                    stdout,
                    stderr: '',
                    exit_code: result.exitCode ?? 1,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `bash failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

const NO_TOOL_MEMORY_REASON =
    'memory tools require a Memory node with storage_kind="markdown" and tool_access set to "read" or "read_write" wired to the Agent';

export function createMemoryReadTool(handle: MemoryHandle | null): Tool {
    return {
        spec: MEMORY_READ_SPEC,
        handler: async () => {
            if (!handle) {
                return { stdout: '', stderr: NO_TOOL_MEMORY_REASON, exit_code: 1 };
            }
            return { stdout: readMarkdownContent(handle), stderr: '', exit_code: 0 };
        },
    };
}

export function createMemoryWriteTool(handle: MemoryHandle | null): Tool {
    return {
        spec: MEMORY_WRITE_SPEC,
        handler: async (args) => {
            if (!handle) {
                return { stdout: '', stderr: NO_TOOL_MEMORY_REASON, exit_code: 1 };
            }
            const content = typeof args.content === 'string' ? args.content : null;
            if (content === null) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: content',
                    exit_code: 1,
                };
            }
            try {
                writeMarkdownContent(handle, content);
                const bytes = Buffer.byteLength(content, 'utf8');
                return {
                    stdout: `wrote ${bytes} bytes to memory`,
                    stderr: '',
                    exit_code: 0,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `memory write failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

const NO_GRAPH_STORE_REASON = 'graph tools require a GraphStore (runner not wired)';

export function createReadCanvasTool(
    graphStore: GraphStore | null,
    l1GraphId: string | null,
): Tool {
    return {
        spec: READ_CANVAS_SPEC,
        handler: async () => {
            if (!graphStore) {
                return { stdout: '', stderr: NO_GRAPH_STORE_REASON, exit_code: 1 };
            }
            if (!l1GraphId) {
                return {
                    stdout: '',
                    stderr: 'this agent has no L1 graph id (running unsaved/standalone) — no parent L2 to resolve as the active canvas',
                    exit_code: 1,
                };
            }
            try {
                const summaries = await graphStore.list({ kind: 'l2' });
                for (const summary of summaries) {
                    if (!summary.id) continue;
                    const l2 = await graphStore.get(summary.id);
                    if (!l2) continue;
                    const match = l2.nodes.some(
                        (n) =>
                            n.type === 'native_agent' &&
                            'l1_graph_id' in n &&
                            n.l1_graph_id === l1GraphId,
                    );
                    if (match) {
                        return { stdout: JSON.stringify(l2), stderr: '', exit_code: 0 };
                    }
                }
                return {
                    stdout: '',
                    stderr: `no active canvas — this agent (l1=${l1GraphId}) is not embedded in any L2 (running standalone, e.g. via DebugGateway). Ask the user to specify a target L2, or have them drop this agent onto a canvas.`,
                    exit_code: 1,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `read_canvas failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

export function createReadGraphTool(graphStore: GraphStore | null): Tool {
    return {
        spec: READ_GRAPH_SPEC,
        handler: async (args) => {
            if (!graphStore) {
                return { stdout: '', stderr: NO_GRAPH_STORE_REASON, exit_code: 1 };
            }
            const id = typeof args.id === 'string' ? args.id : '';
            if (!id) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: id',
                    exit_code: 1,
                };
            }
            try {
                const graph = await graphStore.get(id);
                if (!graph) {
                    return {
                        stdout: '',
                        stderr: `graph not found: ${id}`,
                        exit_code: 1,
                    };
                }
                return { stdout: JSON.stringify(graph), stderr: '', exit_code: 0 };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `read_graph failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

function isKnownGraphKind(value: unknown): value is GraphKind {
    return typeof value === 'string' && KNOWN_GRAPH_KINDS.has(value as GraphKind);
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

export function createCreateGraphTool(
    graphStore: GraphStore | null,
    runtimes: GraphRuntimeRegistry | null,
): Tool {
    return {
        spec: CREATE_GRAPH_SPEC,
        handler: async (args) => {
            if (!graphStore || !runtimes) {
                return { stdout: '', stderr: NO_GRAPH_STORE_REASON, exit_code: 1 };
            }
            const kind = args.kind;
            if (!isKnownGraphKind(kind)) {
                return {
                    stdout: '',
                    stderr: 'kind must be one of: toolpack, skillpack, handler, l1, l2',
                    exit_code: 1,
                };
            }
            if (args.library !== undefined && args.library !== null && args.library !== false) {
                return {
                    stdout: '',
                    stderr: 'library flag is not settable from create_graph; templates ship as boot migrations',
                    exit_code: 1,
                };
            }
            const draft: GraphDraft = {
                kind,
                nodes: asArray(args.nodes) as Graph['nodes'],
                edges: asArray(args.edges) as Graph['edges'],
                ...(typeof args.name === 'string' ? { name: args.name } : {}),
                ...(typeof args.description === 'string' ? { description: args.description } : {}),
            };
            try {
                const result = await createGraphPersist(graphStore, runtimes, draft);
                if (!result.ok) {
                    return {
                        stdout: '',
                        stderr: result.error.message,
                        exit_code: 1,
                    };
                }
                return {
                    stdout: JSON.stringify({
                        id: result.value.graph.id,
                        graph: result.value.graph,
                        remap: result.value.remap,
                    }),
                    stderr: '',
                    exit_code: 0,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `create_graph failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

export function createEditGraphTool(
    graphStore: GraphStore | null,
    runtimes: GraphRuntimeRegistry | null,
): Tool {
    return {
        spec: EDIT_GRAPH_SPEC,
        handler: async (args) => {
            if (!graphStore || !runtimes) {
                return { stdout: '', stderr: NO_GRAPH_STORE_REASON, exit_code: 1 };
            }
            const id = typeof args.id === 'string' ? args.id : '';
            if (!id) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: id',
                    exit_code: 1,
                };
            }
            if (!isValidGraphId(id)) {
                return { stdout: '', stderr: `invalid graph id: ${id}`, exit_code: 1 };
            }
            const rawGraph = args.graph;
            if (!rawGraph || typeof rawGraph !== 'object' || Array.isArray(rawGraph)) {
                return {
                    stdout: '',
                    stderr: 'graph must be an object with kind, nodes, edges',
                    exit_code: 1,
                };
            }
            const incoming = rawGraph as Record<string, unknown>;
            const kind = incoming.kind;
            if (!isKnownGraphKind(kind)) {
                return {
                    stdout: '',
                    stderr: 'graph.kind must be one of: toolpack, skillpack, handler, l1, l2',
                    exit_code: 1,
                };
            }
            if (typeof incoming.id === 'string' && incoming.id !== id) {
                return {
                    stdout: '',
                    stderr: `graph.id (${incoming.id}) does not match target id (${id})`,
                    exit_code: 1,
                };
            }
            const existing = await graphStore.get(id);
            if (!existing) {
                return { stdout: '', stderr: `graph not found: ${id}`, exit_code: 1 };
            }
            if (kind !== existing.kind) {
                return {
                    stdout: '',
                    stderr: `graph.kind (${kind}) does not match existing kind (${existing.kind})`,
                    exit_code: 1,
                };
            }
            const incomingLibrary = incoming.library;
            const existingLibrary = existing.library === true;
            if (incomingLibrary !== undefined && incomingLibrary !== null) {
                const requested = incomingLibrary === true;
                if (requested !== existingLibrary) {
                    return {
                        stdout: '',
                        stderr: 'library flag is immutable once set',
                        exit_code: 1,
                    };
                }
            }
            const draft: GraphDraft = {
                kind,
                nodes: asArray(incoming.nodes) as Graph['nodes'],
                edges: asArray(incoming.edges) as Graph['edges'],
                ...(typeof incoming.name === 'string' ? { name: incoming.name } : {}),
                ...(typeof incoming.description === 'string'
                    ? { description: incoming.description }
                    : {}),
                ...(existingLibrary ? { library: true } : {}),
            };
            try {
                const result = await withGraphLock(id, () =>
                    applyGraphEdit(graphStore, runtimes, id, draft),
                );
                if (!result.ok) {
                    return {
                        stdout: '',
                        stderr: result.error.message,
                        exit_code: 1,
                    };
                }
                return {
                    stdout: JSON.stringify({
                        id: result.value.graph.id,
                        graph: result.value.graph,
                        remap: result.value.remap,
                    }),
                    stderr: '',
                    exit_code: 0,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `edit_graph failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

export function createInstantiateCompositeTool(graphStore: GraphStore | null): Tool {
    return {
        spec: INSTANTIATE_COMPOSITE_SPEC,
        handler: async (args) => {
            if (!graphStore) {
                return { stdout: '', stderr: NO_GRAPH_STORE_REASON, exit_code: 1 };
            }
            const templateId = typeof args.template_id === 'string' ? args.template_id : '';
            if (!templateId) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: template_id',
                    exit_code: 1,
                };
            }
            const template = await graphStore.get(templateId);
            if (!template) {
                return {
                    stdout: '',
                    stderr: `template not found: ${templateId}`,
                    exit_code: 1,
                };
            }
            if (template.library !== true) {
                return {
                    stdout: '',
                    stderr: `graph ${templateId} is not a library template (library !== true)`,
                    exit_code: 1,
                };
            }
            try {
                const { copy, remap } = await instantiateLibraryGraph(graphStore, templateId);
                if (!copy.id) {
                    return {
                        stdout: '',
                        stderr: 'instantiate_composite: persisted copy has no id',
                        exit_code: 1,
                    };
                }
                const remapObj: Record<string, string> = {};
                for (const [k, v] of remap) {
                    remapObj[k] = v;
                }
                return {
                    stdout: JSON.stringify({ id: copy.id, remap: remapObj }),
                    stderr: '',
                    exit_code: 0,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `instantiate_composite failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}

export interface BuiltinToolDispatchContext {
    currentDispatch: DispatchEvent;
    outgoing: readonly Edge[];
    topicFor(edge: Edge): string;
}

export interface BuiltinToolBuildCtx {
    bus: EventBus;
    callerNodeId: string;
    currentContext(): BuiltinToolDispatchContext | null;
    reachableAgents: ReadonlyArray<{ id: string; displayName: string; description?: string }>;
}

export type AskAgentDispatchContext = BuiltinToolDispatchContext;
export type AskAgentBuildCtx = BuiltinToolBuildCtx;

export const ASK_AGENT_DEFAULT_TIMEOUT_MS = 60_000;

export const ASK_AGENT_MAX_CHAIN_DEPTH = 8;

const NO_DISPATCH_CONTEXT_REASON =
    'ask_agent requires an in-flight Dispatch context (tool was invoked outside an agent loop)';

function readAskChain(meta: Record<string, unknown> | undefined): string[] {
    const raw = meta?.ask_chain;
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string');
}

export type AgentCallResult =
    | { kind: 'ok'; content: string; childEventId: string }
    | { kind: 'no_context' }
    | { kind: 'cycle'; message: string }
    | { kind: 'depth'; message: string }
    | { kind: 'no_edge'; message: string }
    | { kind: 'publish_failed'; message: string; childEventId: string }
    | { kind: 'timeout'; childEventId: string }
    // The caller's Dispatch was stopped (panic button) while it blocked on the
    // reply. The child cascade already aborted the callee; this just unblocks
    // the parent so `runToolExec`'s cooperative gate can terminate it as
    // stopped instead of hanging on a callee it just killed.
    | { kind: 'cancelled'; childEventId?: string };

export interface AgentCallOptions {
    targetAgentId: string;
    brief: string;
    inheritSession?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export async function publishAndAwaitAgentReply(
    buildCtx: BuiltinToolBuildCtx,
    opts: AgentCallOptions,
): Promise<AgentCallResult> {
    const { targetAgentId, brief } = opts;
    const inheritSession = opts.inheritSession === true;
    const requestedTimeout =
        opts.timeoutMs !== undefined && opts.timeoutMs > 0
            ? opts.timeoutMs
            : ASK_AGENT_DEFAULT_TIMEOUT_MS;

    const ctx = buildCtx.currentContext();
    if (!ctx) return { kind: 'no_context' };

    const callerNodeId = buildCtx.callerNodeId;

    const priorChain = readAskChain(ctx.currentDispatch.meta);
    if (targetAgentId === callerNodeId) {
        return { kind: 'cycle', message: `agent ${callerNodeId} cannot ask itself` };
    }
    if (priorChain.includes(targetAgentId)) {
        const chainStr = [...priorChain, callerNodeId, targetAgentId].join(' -> ');
        return {
            kind: 'cycle',
            message: `${targetAgentId} is already on the ask-chain (${chainStr})`,
        };
    }
    const nextChain = [...priorChain, callerNodeId];
    if (nextChain.length > ASK_AGENT_MAX_CHAIN_DEPTH) {
        const chainStr = [...nextChain, targetAgentId].join(' -> ');
        return {
            kind: 'depth',
            message: `depth cap exceeded (max ${ASK_AGENT_MAX_CHAIN_DEPTH}): ${chainStr}`,
        };
    }

    const matchEdge = ctx.outgoing.find((e) => e.target.node_id === targetAgentId);
    if (!matchEdge) {
        return {
            kind: 'no_edge',
            message: `no outgoing edge from caller (${callerNodeId}) to ${targetAgentId} — wire the L2 agent nodes first`,
        };
    }

    const askCallId = `ask-${randomUUIDLike()}`;
    const outbound = inheritSession
        ? childDispatch(ctx.currentDispatch, {
              messages: [{ role: 'user', content: brief }],
              meta: {
                  ask_call_id: askCallId,
                  ask_chain: nextChain,
                  ask_caller_node_id: callerNodeId,
                  ask_callee_node_id: targetAgentId,
              },
          })
        : newDispatch({
              source: `ask:${callerNodeId}->${targetAgentId}:placeholder`,
              messages: [{ role: 'user', content: brief }],
              meta: {
                  ...ctx.currentDispatch.meta,
                  ask_call_id: askCallId,
                  ask_chain: nextChain,
                  ask_caller_node_id: callerNodeId,
                  ask_callee_node_id: targetAgentId,
              },
          });
    if (!inheritSession) {
        (outbound as { source: string }).source =
            `ask:${callerNodeId}->${targetAgentId}:${outbound.eventId}`;
    }

    if (opts.signal?.aborted) {
        return { kind: 'cancelled', childEventId: outbound.eventId };
    }
    const reply = waitForAskReply(buildCtx.bus, askCallId, requestedTimeout, opts.signal);
    buildCtx.bus.emitDispatch(outbound);
    try {
        await buildCtx.bus.publish(ctx.topicFor(matchEdge), outbound);
    } catch (err) {
        reply.cancel();
        buildCtx.bus.emitObservability({
            ts: new Date().toISOString(),
            eventId: outbound.eventId,
            parentId: outbound.eventId,
            node_id: callerNodeId,
            type: 'chain.stopped',
            reason: 'ask publish failed',
        });
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: 'publish_failed', message: msg, childEventId: outbound.eventId };
    }
    const result = await reply.promise;
    if (result.kind === 'timeout') {
        return { kind: 'timeout', childEventId: outbound.eventId };
    }
    if (result.kind === 'cancelled') {
        return { kind: 'cancelled', childEventId: outbound.eventId };
    }
    return {
        kind: 'ok',
        content: lastMessageContent(result.event) ?? '',
        childEventId: outbound.eventId,
    };
}

async function runAskAgent(
    buildCtx: BuiltinToolBuildCtx,
    opts: {
        targetAgentId: string;
        brief: string;
        inheritSession: boolean;
        timeoutMs?: number;
        signal?: AbortSignal;
    },
): Promise<ToolResult> {
    const result = await publishAndAwaitAgentReply(buildCtx, {
        targetAgentId: opts.targetAgentId,
        brief: opts.brief,
        inheritSession: opts.inheritSession,
        ...(opts.timeoutMs !== undefined && opts.timeoutMs > 0
            ? { timeoutMs: opts.timeoutMs }
            : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    });
    switch (result.kind) {
        case 'no_context':
            return { stdout: '', stderr: NO_DISPATCH_CONTEXT_REASON, exit_code: 1 };
        case 'cycle':
            return {
                stdout: '',
                stderr: `ask_agent cycle: ${result.message}`,
                exit_code: 1,
            };
        case 'depth':
            return { stdout: '', stderr: `ask_agent ${result.message}`, exit_code: 1 };
        case 'no_edge':
            return { stdout: '', stderr: result.message, exit_code: 1 };
        case 'publish_failed':
            return {
                stdout: '',
                stderr: `ask_agent publish failed: ${result.message}`,
                exit_code: 1,
                child_event_id: result.childEventId,
            };
        case 'timeout':
            return {
                stdout: '',
                stderr: `ask_agent timed out after ${
                    opts.timeoutMs !== undefined && opts.timeoutMs > 0
                        ? opts.timeoutMs
                        : ASK_AGENT_DEFAULT_TIMEOUT_MS
                }ms waiting for reply from ${opts.targetAgentId}`,
                exit_code: 1,
                child_event_id: result.childEventId,
            };
        case 'ok':
            return {
                stdout: result.content,
                stderr: '',
                exit_code: 0,
                child_event_id: result.childEventId,
            };
        case 'cancelled':
            return {
                stdout: '',
                stderr: '[cancelled by user]',
                exit_code: 1,
                ...(result.childEventId ? { child_event_id: result.childEventId } : {}),
            };
    }
}

export function createAskAgentTool(buildCtx: BuiltinToolBuildCtx | null): Tool {
    return {
        spec: ASK_AGENT_SPEC,
        handler: async (args, ctx) => {
            if (!buildCtx) {
                return { stdout: '', stderr: NO_DISPATCH_CONTEXT_REASON, exit_code: 1 };
            }
            const targetAgentId =
                typeof args.target_agent_id === 'string' ? args.target_agent_id : '';
            if (!targetAgentId) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: target_agent_id',
                    exit_code: 1,
                };
            }
            const brief = typeof args.brief === 'string' ? args.brief : '';
            if (brief.length === 0) {
                return { stdout: '', stderr: 'brief required', exit_code: 1 };
            }
            return runAskAgent(buildCtx, {
                targetAgentId,
                brief,
                inheritSession: args.inherit_session === true,
                ...(typeof args.timeout_ms === 'number' && args.timeout_ms > 0
                    ? { timeoutMs: args.timeout_ms }
                    : {}),
                ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
        },
    };
}

function slugForToolName(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

const ASK_AGENT_TOOL_NAME_MAX = 64;

export function createAskAgentTools(buildCtx: BuiltinToolBuildCtx | null): Tool[] {
    if (!buildCtx) return [];
    const used = new Set<string>();
    const tools: Tool[] = [];
    for (const entry of buildCtx.reachableAgents) {
        let base = slugForToolName(entry.displayName);
        if (base.length === 0) base = slugForToolName(entry.id);
        if (base.length === 0) base = 'agent';
        const name = uniqueAskAgentToolName(base, used);
        used.add(name);

        const targetAgentId = entry.id;
        const description =
            entry.description && entry.description.length > 0
                ? entry.description
                : `Delegate to ${entry.displayName}.`;
        tools.push({
            spec: {
                name,
                description,
                parameters: {
                    type: 'object',
                    properties: {
                        brief: ASK_AGENT_BRIEF_PARAM,
                        inherit_session: ASK_AGENT_INHERIT_SESSION_PARAM,
                        timeout_ms: ASK_AGENT_TIMEOUT_PARAM,
                    },
                    required: ['brief'],
                    additionalProperties: false,
                },
            },
            handler: async (args, ctx) => {
                const brief = typeof args.brief === 'string' ? args.brief : '';
                if (brief.length === 0) {
                    return { stdout: '', stderr: 'brief required', exit_code: 1 };
                }
                return runAskAgent(buildCtx, {
                    targetAgentId,
                    brief,
                    inheritSession: args.inherit_session === true,
                    ...(typeof args.timeout_ms === 'number' && args.timeout_ms > 0
                        ? { timeoutMs: args.timeout_ms }
                        : {}),
                    ...(ctx.signal ? { signal: ctx.signal } : {}),
                });
            },
        });
    }
    return tools;
}

function uniqueAskAgentToolName(base: string, used: Set<string>): string {
    const prefix = 'ask_agent_';
    const budget = ASK_AGENT_TOOL_NAME_MAX - prefix.length;
    let candidate = `${prefix}${base.slice(0, budget)}`;
    let n = 2;
    while (used.has(candidate)) {
        const suffix = `_${n}`;
        candidate = `${prefix}${base.slice(0, budget - suffix.length)}${suffix}`;
        n += 1;
    }
    return candidate;
}

type AskReplyResult =
    | { kind: 'reply'; event: DispatchEvent }
    | { kind: 'timeout' }
    | { kind: 'cancelled' };

interface AskReplyWaiter {
    promise: Promise<AskReplyResult>;
    cancel(): void;
}

function waitForAskReply(
    bus: EventBus,
    askCallId: string,
    timeoutMs: number,
    signal?: AbortSignal,
): AskReplyWaiter {
    let cleanup: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<AskReplyResult>((resolve) => {
        const off = bus.subscribeDispatch((event) => {
            if (!event.meta) return;
            if (event.meta.ask_call_id !== askCallId) return;
            const port = event.meta.port;
            if (port !== 'result' && port !== 'error') return;
            cleanup?.();
            resolve({ kind: 'reply', event });
        });
        const onAbort = () => {
            cleanup?.();
            resolve({ kind: 'cancelled' });
        };
        cleanup = () => {
            off();
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            cleanup = null;
        };
        timer = setTimeout(() => {
            cleanup?.();
            resolve({ kind: 'timeout' });
        }, timeoutMs);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    return {
        promise,
        cancel: () => cleanup?.(),
    };
}

function lastMessageContent(event: DispatchEvent): string | null {
    const msg = event.messages[event.messages.length - 1];
    if (!msg) return null;
    return typeof msg.content === 'string' ? msg.content : null;
}

function randomUUIDLike(): string {
    const a = Math.floor(Math.random() * 0xffffffff).toString(16);
    const b = Math.floor(Math.random() * 0xffffffff).toString(16);
    const c = Date.now().toString(16);
    return `${a}-${b}-${c}`;
}

export interface PriorTurnEntry {
    eventId: string;
    timestamp: number;
    role: 'user' | 'assistant';
    content: string;
}

export const PRIOR_TURNS_DEFAULT_LIMIT = 10;

const NO_DISPATCH_CONTEXT_REASON_PRIOR_TURNS =
    'prior_turns requires an in-flight Dispatch context (tool was invoked outside an agent loop)';

export function createPriorTurnsTool(buildCtx: BuiltinToolBuildCtx | null): Tool {
    return {
        spec: PRIOR_TURNS_SPEC,
        handler: async (args) => {
            if (!buildCtx) {
                return {
                    stdout: '',
                    stderr: NO_DISPATCH_CONTEXT_REASON_PRIOR_TURNS,
                    exit_code: 1,
                };
            }
            const ctx = buildCtx.currentContext();
            if (!ctx) {
                return {
                    stdout: '',
                    stderr: NO_DISPATCH_CONTEXT_REASON_PRIOR_TURNS,
                    exit_code: 1,
                };
            }
            const requestedLimit =
                typeof args.limit === 'number' && args.limit > 0
                    ? Math.floor(args.limit)
                    : PRIOR_TURNS_DEFAULT_LIMIT;

            const source = ctx.currentDispatch.source;
            if (source === '') {
                return { stdout: '[]', stderr: '', exit_code: 0 };
            }

            const allRoots = buildCtx.bus.rootEventIdsBySource(source);
            const priorRoots = allRoots.filter((id) => id !== ctx.currentDispatch.eventId);

            const trimmedRoots = priorRoots.slice(-requestedLimit);

            const entries: PriorTurnEntry[] = [];
            for (const rootId of trimmedRoots) {
                const events = buildCtx.bus.eventsByDispatch(rootId);
                const userTurn = extractUserEntry(rootId, events);
                if (userTurn) entries.push(userTurn);
                const assistantTurn = extractAssistantEntry(rootId, events);
                if (assistantTurn) entries.push(assistantTurn);
            }

            return { stdout: JSON.stringify(entries), stderr: '', exit_code: 0 };
        },
    };
}

function extractUserEntry(
    rootId: string,
    events: ReadonlyArray<DispatchEvent | ObservabilityEvent>,
): PriorTurnEntry | null {
    for (const event of events) {
        if (!isPlainDispatchEvent(event)) continue;
        if (event.eventId !== rootId) continue;
        if (event.parentId) continue;
        const first = event.messages[0];
        if (!first) return null;
        return {
            eventId: event.eventId,
            timestamp: event.timestamp,
            role: 'user',
            content: typeof first.content === 'string' ? first.content : '',
        };
    }
    return null;
}

function extractAssistantEntry(
    rootId: string,
    events: ReadonlyArray<DispatchEvent | ObservabilityEvent>,
): PriorTurnEntry | null {
    let chosen: OutputEmittedEvent | null = null;
    for (const event of events) {
        if (!isObservabilityEvent(event)) continue;
        if (event.type !== 'output.emitted') continue;
        if (event.eventId !== rootId) continue;
        chosen = event;
    }
    if (!chosen) return null;
    const last = chosen.messages[chosen.messages.length - 1];
    const tsMs = Date.parse(chosen.ts);
    return {
        eventId: chosen.eventId,
        timestamp: Number.isNaN(tsMs) ? 0 : tsMs,
        role: 'assistant',
        content: last && typeof last.content === 'string' ? last.content : '',
    };
}

function isObservabilityEvent(
    event: DispatchEvent | ObservabilityEvent,
): event is ObservabilityEvent {
    return 'type' in event;
}

function isPlainDispatchEvent(event: DispatchEvent | ObservabilityEvent): event is DispatchEvent {
    return !('type' in event);
}

export function createListDirectoryTool(workspace: WorkspaceBinding | null): Tool {
    const root = workspace ? resolve(workspace.path) : resolve(process.cwd());
    return {
        spec: LIST_DIRECTORY_SPEC,
        handler: async (args) => {
            const raw = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.';
            const resolved = resolveInside(root, raw);
            if (!resolved.ok) {
                return { stdout: '', stderr: resolved.reason, exit_code: 1 };
            }
            try {
                const s = await stat(resolved.path);
                if (!s.isDirectory()) {
                    return {
                        stdout: '',
                        stderr: `not a directory: ${raw}`,
                        exit_code: 1,
                    };
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `stat failed: ${msg}`, exit_code: 1 };
            }
            try {
                const entries = await readdir(resolved.path, { withFileTypes: true });
                const lines = entries
                    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
                    .sort((a, b) => a.localeCompare(b));
                return { stdout: lines.join('\n'), stderr: '', exit_code: 0 };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { stdout: '', stderr: `readdir failed: ${msg}`, exit_code: 1 };
            }
        },
    };
}
