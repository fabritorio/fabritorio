#!/usr/bin/env node
// Build the flattened `npx fabritorio` publish package.
//
// Produces `dist-pkg/` (gitignored) at the repo root:
//
//   dist-pkg/
//     bin/fabritorio.js     launcher (shebang, executable)
//     dist/server.js        esbuild-bundled runner (one ESM file)
//     web/                  contents of apps/web/out (the static SPA)
//     seed-skills/          shipped system skills (foreman / tool-builder / skill-builder)
//     package.json          NEW minimal manifest — NOT the workspace root's
//
// This is NOT the workspace: it is a self-contained tree that `npm publish`
// uploads and `npm i -g fabritorio` / `npx fabritorio` installs. The launcher
// points the bundled runner at this tree's `web/` and `seed-skills/` via
// `FAB_WEB_DIR` / `FAB_SEED_SKILLS_DIR` (see bin/fabritorio.js for why the
// runner's default relative resolves don't hold once flattened).
//
// Idempotent + reproducible: wipes `dist-pkg/` on each run and rebuilds.
//
// Steps:
//   1. build @fabritorio/types (the bundle imports it; its `exports` point at
//      dist/, so it must be compiled before esbuild can resolve it)
//   2. next export the web -> apps/web/out
//   3. esbuild-bundle apps/runner/src/index.ts -> dist-pkg/dist/server.js
//   4. assemble the flattened tree + write the minimal package.json
//
// MANUAL FINAL STEP — PUBLISHING IS NOT AUTOMATED:
//   The publish is done by hand by the maintainer, never by this script or CI.
//   After this script succeeds:   cd dist-pkg && npm publish
//   (run `npm pack ./dist-pkg` first to eyeball the tarball contents).

import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const stage = join(repoRoot, 'dist-pkg');

function run(cmd, args, opts = {}) {
    process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
    execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', ...opts });
}

// --- 0. clean slate (idempotent) ---------------------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
mkdirSync(join(stage, 'dist'), { recursive: true });

// --- 1. build the shared types package (esbuild resolves it from dist/) ------
run('pnpm', ['--filter', '@fabritorio/types', 'build']);

// --- 2. static-export the web -> apps/web/out --------------------------------
run('pnpm', ['--filter', '@fabritorio/web', 'build']);
const webOut = join(repoRoot, 'apps', 'web', 'out');
if (!existsSync(join(webOut, 'index.html'))) {
    throw new Error(`web export missing: ${join(webOut, 'index.html')} not found after build`);
}

// --- 3. esbuild-bundle the runner entry -> dist-pkg/dist/server.js -----------
// ESM-bundle gotcha shims (see bin/fabritorio.js notes too):
//   - some CJS deps (e.g. dotenv) call `require('fs')` at runtime; an ESM
//     bundle has no `require`, so inject one via createRequire.
//   - re-provide `__filename`/`__dirname` for any dep that reads them.
// `import.meta.url` is left intact by esbuild and resolves to the final
// dist/server.js; the runner's `pkg.version` read (`../package.json`) therefore
// lands on dist-pkg/package.json, which step 4 writes with a real version.
const banner = [
    "import { createRequire as __fabCreateRequire } from 'node:module';",
    "import { fileURLToPath as __fabFileURLToPath } from 'node:url';",
    "import { dirname as __fabDirname } from 'node:path';",
    'const require = __fabCreateRequire(import.meta.url);',
    'const __filename = __fabFileURLToPath(import.meta.url);',
    'const __dirname = __fabDirname(__filename);',
].join('');

run(join(repoRoot, 'node_modules', '.bin', 'esbuild'), [
    join(repoRoot, 'apps', 'runner', 'src', 'index.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node24',
    `--banner:js=${banner}`,
    // All runtime deps are pure-JS and bundle cleanly (verified: no native
    // .node addons in fastify/openai/@google/genai/@anthropic-ai/sdk/cheerio/
    // linkedom/turndown/@mozilla/readability/croner/gray-matter/dotenv). So
    // nothing is externalized — the bundle is fully self-contained and the
    // published package needs ZERO runtime `dependencies`. If a future dep
    // misbehaves under bundling, add `--external:<pkg>` here AND list it under
    // `dependencies` in the manifest below so `npm i -g` pulls it.
    `--outfile=${join(stage, 'dist', 'server.js')}`,
]);

// --- 4. assemble the flattened tree ------------------------------------------
// web/ — contents of apps/web/out (launcher sets FAB_WEB_DIR to this)
cpSync(webOut, join(stage, 'web'), { recursive: true });

// seed-skills/ — shipped system skills (launcher sets FAB_SEED_SKILLS_DIR)
cpSync(join(repoRoot, 'apps', 'runner', 'seed-skills'), join(stage, 'seed-skills'), {
    recursive: true,
});

// bin/fabritorio.js — the launcher (kept in scripts/, copied in + chmod +x)
cpSync(join(here, 'fabritorio-launcher.js'), join(stage, 'bin', 'fabritorio.js'));
chmodSync(join(stage, 'bin', 'fabritorio.js'), 0o755);

// package.json — NEW minimal manifest. Version mirrors the workspace root so
// the two stay in sync (read at build time, not hardcoded). No `dependencies`
// because the bundle inlines everything (see step 3).
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const manifest = {
    name: 'fabritorio',
    version: rootPkg.version,
    description: rootPkg.description,
    type: 'module',
    bin: { fabritorio: 'bin/fabritorio.js' },
    files: ['bin', 'dist', 'web', 'seed-skills'],
    engines: { node: '>=24' },
    license: rootPkg.license ?? 'MIT',
};
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

process.stdout.write(`\nPackaged -> ${stage}\n`);
process.stdout.write('  bin/fabritorio.js  dist/server.js  web/  seed-skills/  package.json\n');
process.stdout.write(
    '\nNEXT (manual, NOT run by this script): cd dist-pkg && npm publish\n' +
        '(verify first with: npm pack ./dist-pkg && tar tzf fabritorio-*.tgz)\n',
);
