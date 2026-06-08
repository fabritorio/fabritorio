export interface ToolConfigField {
    name: string;
    kind: 'enum' | 'string';
    label: string;
    description?: string;
    options?: string[];
    placeholder?: string;
    showWhen?: { field: string; equals: string };
    required?: boolean;
}

export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    config_schema?: ToolConfigField[];
}

export interface ToolResult {
    stdout: string;
    stderr: string;
    exit_code: number;
    child_event_id?: string;
}

export interface ToolHandlerContext {
    call_id: string;
    eventId: string;
    signal?: AbortSignal;
}

export interface Tool {
    spec: ToolSpec;
    handler: (
        args: Record<string, unknown>,
        ctx: ToolHandlerContext,
    ) => Promise<ToolResult> | ToolResult;
    argSignature?: (args: Record<string, unknown>) => string;
}

export interface ToolRegistry {
    list(): ToolSpec[];
    listTools(): Tool[];
    get(name: string): Tool | undefined;
    register(tool: Tool): void;
}

export function createToolRegistry(tools: Tool[] = []): ToolRegistry {
    const byName = new Map<string, Tool>();
    for (const tool of tools) {
        byName.set(tool.spec.name, tool);
    }
    return {
        list: () => Array.from(byName.values(), (t) => t.spec),
        listTools: () => Array.from(byName.values()),
        get: (name) => byName.get(name),
        register: (tool) => {
            byName.set(tool.spec.name, tool);
        },
    };
}

import { readFileSync } from 'node:fs';
import type { SkillRegistry } from './skills.js';

export function createSkillTool(registry: SkillRegistry, allowedNames?: ReadonlySet<string>): Tool {
    return {
        spec: {
            name: 'Skill',
            description:
                "Load a skill by name. Without `resource`, returns the skill's core body (SKILL.md). " +
                'A skill may also ship named resource files — deeper recipes / references it tells you to ' +
                'load on demand; pass `resource` with the file name (the `.md` suffix is optional) to fetch ' +
                'one. Load a resource only when you are about to do the thing it covers, not while reasoning.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'The exact name of the skill to load',
                    },
                    resource: {
                        type: 'string',
                        description:
                            "Optional: a resource file shipped alongside this skill's SKILL.md (e.g. " +
                            "'recipe-build-agent'). Returns that file's contents instead of the core body. " +
                            'The core body lists which resources exist and when to load each.',
                    },
                },
                required: ['name'],
                additionalProperties: false,
            },
        },
        handler: (args) => {
            const name = typeof args.name === 'string' ? args.name : '';
            if (!name) {
                return {
                    stdout: '',
                    stderr: 'missing required argument: name',
                    exit_code: 1,
                };
            }
            if (allowedNames && !allowedNames.has(name)) {
                return {
                    stdout: '',
                    stderr: `skill "${name}" is not wired to this agent`,
                    exit_code: 1,
                };
            }
            let skill = registry.get(name);
            if (!skill) {
                registry.rescan();
                skill = registry.get(name);
            }
            if (!skill) {
                return {
                    stdout: '',
                    stderr: `unknown skill "${name}"`,
                    exit_code: 1,
                };
            }

            const resource = typeof args.resource === 'string' ? args.resource.trim() : '';
            if (resource) {
                const wanted = resource.replace(/\.md$/i, '');
                const match = skill.resources.find(
                    (r) => r.name === resource || r.name.replace(/\.md$/i, '') === wanted,
                );
                if (!match) {
                    const available = skill.resources.map((r) => r.name).join(', ') || '(none)';
                    return {
                        stdout: '',
                        stderr: `skill "${name}" has no resource "${resource}". Available: ${available}`,
                        exit_code: 1,
                    };
                }
                try {
                    return { stdout: readFileSync(match.path, 'utf8'), stderr: '', exit_code: 0 };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return { stdout: '', stderr: `failed to read resource: ${msg}`, exit_code: 1 };
                }
            }

            return {
                stdout: skill.body,
                stderr: '',
                exit_code: 0,
            };
        },
    };
}

export const getCurrentTimeTool: Tool = {
    spec: {
        name: 'get_current_time',
        description: 'Return the current UTC timestamp in ISO 8601 format. Takes no arguments.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    handler: () => ({
        stdout: new Date().toISOString(),
        stderr: '',
        exit_code: 0,
    }),
};

export function createDefaultToolRegistry(): ToolRegistry {
    return createToolRegistry([getCurrentTimeTool]);
}
