import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { runBashCliAdapter } from './tool-adapters/bash-cli.js';
import type { Tool, ToolSpec } from './tools.js';

export type ToolAdapterName = 'bash_cli';

export interface BashCliAdapterConfig {
    binary: string;
    arg_style: 'flags';
    arg_mapping: Record<string, string>;
    timeout_ms?: number;
}

export interface RuntimeToolManifest {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    adapter: ToolAdapterName;
    adapter_config: BashCliAdapterConfig;
}

export interface RuntimeTool {
    manifest: RuntimeToolManifest;
    dir: string;
    manifest_path: string;
}

export interface RuntimeToolRegistry {
    list(): ToolSpec[];
    get(name: string): RuntimeTool | undefined;
    rescan(): void;
}

export type { ToolSpec } from './tools.js';

export function defaultRuntimeToolRoots(): string[] {
    const env = process.env.FABRITORIO_TOOL_ROOTS;
    if (env && env.length > 0) {
        return env
            .split(':')
            .map((r) => r.trim())
            .filter(Boolean)
            .map((r) => resolve(r));
    }
    return [join(homedir(), '.fabritorio', 'tools')];
}

const KNOWN_ADAPTERS: ReadonlySet<ToolAdapterName> = new Set<ToolAdapterName>(['bash_cli']);
const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function createRuntimeToolRegistry(
    roots: string[] = defaultRuntimeToolRoots(),
): RuntimeToolRegistry {
    let byName = new Map<string, RuntimeTool>();
    const scan = () => {
        const next = new Map<string, RuntimeTool>();
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
                const toolDir = join(root, entry);
                try {
                    if (!statSync(toolDir).isDirectory()) continue;
                } catch {
                    continue;
                }
                const manifestPath = join(toolDir, 'manifest.json');
                if (!existsSync(manifestPath)) continue;
                const rt = loadManifest(toolDir, manifestPath);
                if (!rt) continue;
                if (!next.has(rt.manifest.name)) {
                    next.set(rt.manifest.name, rt);
                }
            }
        }
        byName = next;
    };
    scan();
    return {
        list: () => Array.from(byName.values(), toSpec),
        get: (name) => byName.get(name),
        rescan: scan,
    };
}

function loadManifest(toolDir: string, manifestPath: string): RuntimeTool | null {
    let raw: string;
    try {
        raw = readFileSync(manifestPath, 'utf8');
    } catch (err) {
        console.warn(`[runtime-tools] skipping ${manifestPath}: read failed: ${errorMessage(err)}`);
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        console.warn(
            `[runtime-tools] skipping ${manifestPath}: invalid JSON: ${errorMessage(err)}`,
        );
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[runtime-tools] skipping ${manifestPath}: manifest is not an object`);
        return null;
    }
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!NAME_RE.test(name)) {
        console.warn(
            `[runtime-tools] skipping ${manifestPath}: name "${name}" must match ${NAME_RE}`,
        );
        return null;
    }
    const description = typeof obj.description === 'string' ? obj.description : '';
    const parameters =
        obj.parameters && typeof obj.parameters === 'object' && !Array.isArray(obj.parameters)
            ? (obj.parameters as Record<string, unknown>)
            : null;
    if (!parameters) {
        console.warn(`[runtime-tools] skipping ${manifestPath}: parameters must be an object`);
        return null;
    }
    const adapter = obj.adapter;
    if (typeof adapter !== 'string' || !KNOWN_ADAPTERS.has(adapter as ToolAdapterName)) {
        console.warn(
            `[runtime-tools] skipping ${manifestPath}: unknown adapter "${String(adapter)}"`,
        );
        return null;
    }
    const adapterConfig = obj.adapter_config;
    if (!adapterConfig || typeof adapterConfig !== 'object' || Array.isArray(adapterConfig)) {
        console.warn(`[runtime-tools] skipping ${manifestPath}: adapter_config must be an object`);
        return null;
    }
    const ac = adapterConfig as Record<string, unknown>;
    const binary = typeof ac.binary === 'string' ? ac.binary : '';
    if (!binary) {
        console.warn(`[runtime-tools] skipping ${manifestPath}: adapter_config.binary required`);
        return null;
    }
    const argStyle = ac.arg_style;
    if (argStyle !== 'flags') {
        console.warn(
            `[runtime-tools] skipping ${manifestPath}: arg_style "${String(argStyle)}" not supported (use "flags")`,
        );
        return null;
    }
    const argMapping =
        ac.arg_mapping && typeof ac.arg_mapping === 'object' && !Array.isArray(ac.arg_mapping)
            ? (ac.arg_mapping as Record<string, unknown>)
            : null;
    if (!argMapping) {
        console.warn(
            `[runtime-tools] skipping ${manifestPath}: adapter_config.arg_mapping must be an object`,
        );
        return null;
    }
    const cleanedMapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(argMapping)) {
        if (typeof v !== 'string') {
            console.warn(
                `[runtime-tools] skipping ${manifestPath}: arg_mapping.${k} must be a string`,
            );
            return null;
        }
        cleanedMapping[k] = v;
    }
    const timeoutMs = typeof ac.timeout_ms === 'number' ? ac.timeout_ms : undefined;

    const resolvedBinary = isAbsolute(binary) ? binary : join(toolDir, binary);
    try {
        const s = statSync(resolvedBinary);
        if (!s.isFile() || (s.mode & 0o111) === 0) {
            console.warn(
                `[runtime-tools] skipping ${manifestPath}: binary ${resolvedBinary} is not an executable file`,
            );
            return null;
        }
    } catch (err) {
        console.warn(
            `[runtime-tools] skipping ${manifestPath}: stat ${resolvedBinary} failed: ${errorMessage(err)}`,
        );
        return null;
    }

    const manifest: RuntimeToolManifest = {
        name,
        description,
        parameters,
        adapter: adapter as ToolAdapterName,
        adapter_config: {
            binary,
            arg_style: 'flags',
            arg_mapping: cleanedMapping,
            ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
        },
    };
    return { manifest, dir: toolDir, manifest_path: manifestPath };
}

function toSpec(rt: RuntimeTool): ToolSpec {
    return {
        name: rt.manifest.name,
        description: rt.manifest.description,
        parameters: rt.manifest.parameters,
    };
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function createRuntimeToolFromManifest(
    rt: RuntimeTool,
    resolveSecretEnv?: () => Record<string, string>,
): Tool {
    return {
        spec: toSpec(rt),
        handler: (args, ctx) => {
            const env = resolveSecretEnv?.() ?? {};
            return runBashCliAdapter(rt, args, ctx, { env });
        },
        argSignature: () => rt.manifest.name,
    };
}
