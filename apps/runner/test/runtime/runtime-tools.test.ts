import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeToolRegistry } from '../../src/runtime/runtime-tools.js';

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function writeExecutable(
    dir: string,
    name: string,
    body = '#!/usr/bin/env bash\necho hi\n',
): string {
    const bin = join(dir, name);
    writeFileSync(bin, body, 'utf8');
    chmodSync(bin, 0o755);
    return bin;
}

describe('createRuntimeToolRegistry', () => {
    let root: string;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'fabritorio-runtime-tools-'));
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        warnSpy.mockRestore();
    });

    function seedValid(name: string, description = 'A valid tool'): string {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        writeExecutable(dir, name);
        writeManifest(dir, {
            name,
            description,
            parameters: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
                additionalProperties: false,
            },
            adapter: 'bash_cli',
            adapter_config: {
                binary: name,
                arg_style: 'flags',
                arg_mapping: { message: '--message' },
            },
        });
        return dir;
    }

    it('loads valid manifests and skips malformed ones without throwing', () => {
        seedValid('echo_one', 'first valid');
        seedValid('echo_two', 'second valid');

        const badJsonDir = join(root, 'bad_json');
        mkdirSync(badJsonDir);
        writeExecutable(badJsonDir, 'bad_json');
        writeFileSync(join(badJsonDir, 'manifest.json'), '{not json', 'utf8');

        const badAdapterDir = join(root, 'bad_adapter');
        mkdirSync(badAdapterDir);
        writeExecutable(badAdapterDir, 'bad_adapter');
        writeManifest(badAdapterDir, {
            name: 'bad_adapter',
            description: 'has an unknown adapter',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            adapter: 'http',
            adapter_config: { binary: 'bad_adapter', arg_style: 'flags', arg_mapping: {} },
        });

        const nonExecDir = join(root, 'non_exec');
        mkdirSync(nonExecDir);
        writeFileSync(join(nonExecDir, 'non_exec'), '#!/usr/bin/env bash\n', 'utf8');
        writeManifest(nonExecDir, {
            name: 'non_exec',
            description: 'binary is not executable',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            adapter: 'bash_cli',
            adapter_config: { binary: 'non_exec', arg_style: 'flags', arg_mapping: {} },
        });

        const badNameDir = join(root, 'bad_name');
        mkdirSync(badNameDir);
        writeExecutable(badNameDir, 'bad_name');
        writeManifest(badNameDir, {
            name: 'Bad-Name',
            description: 'caps + dashes are disallowed',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            adapter: 'bash_cli',
            adapter_config: { binary: 'bad_name', arg_style: 'flags', arg_mapping: {} },
        });

        const registry = createRuntimeToolRegistry([root]);

        const specs = registry.list();
        const names = specs.map((s) => s.name).sort();
        expect(names).toEqual(['echo_one', 'echo_two']);

        const echoOne = registry.get('echo_one');
        expect(echoOne).toBeDefined();
        expect(echoOne!.manifest.description).toBe('first valid');
        expect(echoOne!.dir).toBe(join(root, 'echo_one'));

        expect(registry.get('bad_adapter')).toBeUndefined();
        expect(registry.get('non_exec')).toBeUndefined();
        expect(registry.get('Bad-Name')).toBeUndefined();
    });

    it('rescan() picks up tools added after construction', () => {
        seedValid('echo_initial');
        const registry = createRuntimeToolRegistry([root]);
        expect(registry.list().map((s) => s.name)).toEqual(['echo_initial']);

        seedValid('echo_added');
        expect(registry.get('echo_added')).toBeUndefined();

        registry.rescan();
        expect(
            registry
                .list()
                .map((s) => s.name)
                .sort(),
        ).toEqual(['echo_added', 'echo_initial']);
    });

    it('first root wins on name collision', () => {
        const root2 = mkdtempSync(join(tmpdir(), 'fabritorio-runtime-tools-2-'));
        try {
            seedValid('shared', 'from-root-1');
            const dup = join(root2, 'shared');
            mkdirSync(dup, { recursive: true });
            writeExecutable(dup, 'shared');
            writeManifest(dup, {
                name: 'shared',
                description: 'from-root-2',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                adapter: 'bash_cli',
                adapter_config: { binary: 'shared', arg_style: 'flags', arg_mapping: {} },
            });

            const registry = createRuntimeToolRegistry([root, root2]);
            const t = registry.get('shared');
            expect(t).toBeDefined();
            expect(t!.manifest.description).toBe('from-root-1');
        } finally {
            rmSync(root2, { recursive: true, force: true });
        }
    });

    it('list() projects to ToolSpec (name/description/parameters only)', () => {
        seedValid('proj_test', 'the description');
        const registry = createRuntimeToolRegistry([root]);
        const [spec] = registry.list();
        expect(spec).toBeDefined();
        expect(Object.keys(spec!).sort()).toEqual(['description', 'name', 'parameters']);
        expect(spec!.name).toBe('proj_test');
        expect(spec!.parameters).toEqual({
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
        });
    });

    it('returns empty when the root does not exist', () => {
        const registry = createRuntimeToolRegistry([join(root, 'does-not-exist')]);
        expect(registry.list()).toEqual([]);
    });
});
