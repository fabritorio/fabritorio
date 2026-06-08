#!/usr/bin/env node
// Fabritorio launcher — the `bin` of the published `fabritorio` package.
//
// Boots ONE process: the esbuild-bundled runner (sibling `dist/server.js`),
// which serves both the JSON API (under /api) and the static web SPA from the
// same loopback origin. Then opens the browser at that origin.
//
// Layout once published (flattened, NOT the workspace):
//   <pkg>/bin/fabritorio.js   <- this file
//   <pkg>/dist/server.js      <- bundled runner (boots on import; see below)
//   <pkg>/web/                <- static SPA (apps/web/out contents)
//   <pkg>/seed-skills/        <- shipped system skills
//
// All paths resolve from THIS file's own location (import.meta.url), never cwd,
// so `npx fabritorio` works from any directory.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const serverEntry = resolve(pkgRoot, 'dist', 'server.js');
const webDir = resolve(pkgRoot, 'web');
const seedSkillsDir = resolve(pkgRoot, 'seed-skills');

// --- CLI args ---------------------------------------------------------------
// --no-open       don't launch a browser
// --port <n>      bind port (also honours PORT env; the flag wins)
const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');
let portArg;
const portFlagIdx = argv.indexOf('--port');
if (portFlagIdx !== -1) portArg = argv[portFlagIdx + 1];

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4000;

function parsePort(raw, label) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        console.error(`fabritorio: invalid ${label}: ${raw}`);
        process.exit(1);
    }
    return n;
}

// Port precedence: --port flag > PORT env > default 4000.
const requestedPort =
    portArg !== undefined
        ? parsePort(portArg, '--port')
        : process.env.PORT
          ? parsePort(process.env.PORT, 'PORT')
          : DEFAULT_PORT;

// Whether the user pinned an exact port (flag or env). If so, do NOT silently
// fall back to a different port — fail loudly instead, since a fixed port is
// usually an integration contract.
const portPinned = portArg !== undefined || Boolean(process.env.PORT);

// --- port probe (pure JS, no shelling out) ----------------------------------
// Try to bind <host:port>; resolve true if free, false on EADDRINUSE. This is
// the whole point of the launcher's resiliency: a second process on a taken
// port would otherwise EADDRINUSE-die. We probe-and-increment to dodge that.
function isPortFree(port) {
    return new Promise((res) => {
        const srv = net.createServer();
        srv.once('error', (err) => {
            srv.close();
            res(err.code !== 'EADDRINUSE' ? true : false);
        });
        srv.once('listening', () => srv.close(() => res(true)));
        srv.listen(port, HOST);
    });
}

async function pickPort(start) {
    // Scan a small range upward from the requested port.
    const MAX_TRIES = 20;
    for (let p = start; p < start + MAX_TRIES; p++) {
        if (await isPortFree(p)) return p;
        if (portPinned) {
            console.error(
                `fabritorio: port ${p} is in use and a fixed port was requested ` +
                    `(--port/PORT). Free it or pick another.`,
            );
            process.exit(1);
        }
    }
    console.error(
        `fabritorio: no free port found in ${start}..${start + MAX_TRIES - 1}. ` +
            `Pass --port <n> with a free port.`,
    );
    process.exit(1);
}

// --- browser open (best-effort) ---------------------------------------------
function openBrowser(url) {
    if (noOpen) return;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    try {
        // `start` is a cmd builtin (needs a shell); detach + ignore so a missing
        // opener never blocks or crashes the launcher.
        const child =
            platform === 'win32'
                ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
                : spawn(cmd, [url], { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
    } catch {
        // swallow — opening the browser is a convenience, never a requirement
    }
}

async function main() {
    if (!existsSync(serverEntry)) {
        console.error(`fabritorio: bundled server not found at ${serverEntry}`);
        process.exit(1);
    }

    const port = await pickPort(requestedPort);
    const url = `http://${HOST}:${port}`;

    // Hand the bundled runner its config + asset locations via env. The runner's
    // default relative resolves assume the workspace layout (apps/runner/dist
    // with web two levels up at apps/web/out); once flattened those don't hold,
    // so we set FAB_WEB_DIR / FAB_SEED_SKILLS_DIR explicitly to THIS package's
    // bundled copies. HOST stays loopback (the runner default) — never widen it.
    process.env.PORT = String(port);
    process.env.FAB_WEB_DIR = webDir;
    process.env.FAB_SEED_SKILLS_DIR = seedSkillsDir;
    delete process.env.HOST;

    // Boot the server by importing it in-process. apps/runner/src/index.ts calls
    // main() unconditionally at module top-level (no `if (import.meta.main)`
    // guard), so a dynamic import boots the Fastify listen() directly — no extra
    // child process, no double Node startup. We import AFTER setting env so
    // loadConfig()/static-serving see PORT/FAB_WEB_DIR.
    //
    // The per-install token (~/.fabritorio/token) is minted by the runner on
    // boot and delivered to the SPA via GET /api/bootstrap, so the printed URL
    // need NOT carry it — open the bare origin and the SPA fetches the token
    // itself. We print the open line once the import resolves.
    console.log(`\n  Fabritorio is starting on ${url}`);
    console.log(`  Open this in your browser:  ${url}\n`);

    await import(pathToImportUrl(serverEntry));

    // Best-effort browser open after the import kicked off the listen(). A short
    // tick lets the socket bind first; we don't hard-gate on readiness because
    // the open is non-critical and the URL is already printed.
    openBrowser(url);
}

// Windows-safe file:// URL for dynamic import of an absolute path.
function pathToImportUrl(absPath) {
    return new URL(`file://${absPath.startsWith('/') ? '' : '/'}${absPath}`).href;
}

main().catch((err) => {
    console.error('fabritorio: failed to start');
    console.error(err);
    process.exit(1);
});
