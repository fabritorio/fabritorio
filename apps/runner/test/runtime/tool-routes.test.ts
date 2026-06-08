import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerToolRoutes } from '../../src/routes/tools.js';
import { createRuntimeToolRegistry } from '../../src/runtime/runtime-tools.js';
import { inject } from '../helpers/inject.js';

function buildApp(opts: { runtimeRoot?: string } = {}) {
    const app = Fastify({ logger: false });
    app.register(
        async (api) => {
            if (opts.runtimeRoot) {
                registerToolRoutes(api, {
                    runtimeToolRegistry: createRuntimeToolRegistry([opts.runtimeRoot]),
                });
            } else {
                registerToolRoutes(api);
            }
        },
        { prefix: '/api' },
    );
    return app;
}

describe('tool routes', () => {
    it('lists the built-in tool catalog', async () => {
        const app = buildApp();
        try {
            const res = await inject(app, { method: 'GET', url: '/api/tools' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
                tools: Array<{ name: string; description: string; source?: string }>;
            };
            const names = body.tools.map((t) => t.name).sort();
            expect(names).toEqual([
                'ask_agent',
                'bash',
                'create_graph',
                'edit_file',
                'edit_graph',
                'get_current_time',
                'instantiate_composite',
                'list_directory',
                'memory_read',
                'memory_write',
                'prior_turns',
                'read_canvas',
                'read_file',
                'read_graph',
                'web_fetch',
                'web_search',
                'write_file',
            ]);
            for (const t of body.tools) {
                expect(typeof t.name).toBe('string');
                expect(typeof t.description).toBe('string');
                expect(t.description.length).toBeGreaterThan(0);
                expect(t.source).toBe('builtin');
            }
        } finally {
            await app.close();
        }
    });

    describe('with a runtime registry', () => {
        let toolsRoot: string;

        beforeEach(() => {
            toolsRoot = mkdtempSync(join(tmpdir(), 'fabritorio-tool-routes-rt-'));
        });

        afterEach(() => {
            rmSync(toolsRoot, { recursive: true, force: true });
        });

        function seedTool(name: string): void {
            const dir = join(toolsRoot, name);
            mkdirSync(dir, { recursive: true });
            const bin = join(dir, name);
            writeFileSync(bin, '#!/usr/bin/env bash\necho hi\n', 'utf8');
            chmodSync(bin, 0o755);
            writeFileSync(
                join(dir, 'manifest.json'),
                JSON.stringify({
                    name,
                    description: `desc for ${name}`,
                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                    adapter: 'bash_cli',
                    adapter_config: {
                        binary: name,
                        arg_style: 'flags',
                        arg_mapping: {},
                    },
                }),
                'utf8',
            );
        }

        it('lists runtime tools alongside built-ins with source tags', async () => {
            seedTool('runtime_one');
            const app = buildApp({ runtimeRoot: toolsRoot });
            try {
                const res = await inject(app, { method: 'GET', url: '/api/tools' });
                const body = res.json() as {
                    tools: Array<{ name: string; source: string }>;
                };
                const sourceByName = new Map(body.tools.map((t) => [t.name, t.source]));
                expect(sourceByName.get('bash')).toBe('builtin');
                expect(sourceByName.get('runtime_one')).toBe('runtime');
            } finally {
                await app.close();
            }
        });

        it('rescans on each request so a newly-built tool shows up without restart', async () => {
            const app = buildApp({ runtimeRoot: toolsRoot });
            try {
                let res = await inject(app, { method: 'GET', url: '/api/tools' });
                let body = res.json() as { tools: Array<{ name: string }> };
                expect(body.tools.find((t) => t.name === 'late_add')).toBeUndefined();

                seedTool('late_add');

                res = await inject(app, { method: 'GET', url: '/api/tools' });
                body = res.json() as { tools: Array<{ name: string }> };
                expect(body.tools.find((t) => t.name === 'late_add')).toBeDefined();
            } finally {
                await app.close();
            }
        });
    });
});
