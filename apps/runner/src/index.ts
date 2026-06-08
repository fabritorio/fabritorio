import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig, isLoopbackBind } from './config.js';
import { buildServer } from './server.js';
import { createEventBus } from './runtime/event-bus.js';
import { createEventLog } from './runtime/event-log.js';
import { graphIsAutonomous } from './runtime/graph-runtime.js';

// Load repo-root .env regardless of cwd (pnpm dev sets cwd to apps/runner/).
// This file lives at apps/runner/{src,dist}/index, so ../../../.env is the root.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '..', '..', '..', '.env') });

async function main(): Promise<void> {
    const config = loadConfig();
    // Hydrate the bus from disk before any route handlers can reach it, so
    // prior conversations replay correctly across restarts.
    const eventLog = createEventLog();
    const bus = createEventBus();
    const prior = await eventLog.readAll();
    bus.hydrate(prior);

    const app = buildServer({ bus, eventLog });
    await app.listen({ port: config.port, host: config.host });

    // Non-loopback bind guard (docs/install-and-security.md §5.3). `dev:lan`
    // sets HOST=0.0.0.0, exposing the bash tool to the whole LAN. A per-install
    // token is always present now (buildServer mints one), so this no longer
    // refuses to boot — but the Host-allowlist hook 403s *every* request whose
    // Host isn't loopback or in FAB_ALLOWED_HOSTS, so a LAN bind is inert until
    // the operator opts in. Warn loudly so a non-loopback bind is never silent.
    if (!isLoopbackBind(config.host)) {
        const allowed = process.env.FAB_ALLOWED_HOSTS;
        app.log.warn(
            { host: config.host, FAB_ALLOWED_HOSTS: allowed ?? '(unset)' },
            'NON-LOOPBACK BIND: the runner (incl. the bash tool) is reachable beyond localhost. ' +
                'A per-install token is required on every mutating route, and the Host-header ' +
                'allowlist will 403 any request whose Host is not loopback — set FAB_ALLOWED_HOSTS ' +
                'to your LAN host(s) (comma-separated) or all LAN requests are rejected. ' +
                'dev:lan is a DEV-ONLY convenience; do not expose this to an untrusted network.',
        );
    }

    // Graceful shutdown. `tsx watch` restarts by killing this child process and
    // spawning a fresh one that re-binds the port; a clean, *fast* teardown here
    // shrinks the window where the dying child still holds the socket, which is
    // what otherwise races the replacement into `EADDRINUSE` on bulk file
    // changes (e.g. a `git checkout` that rewrites many watched files at once).
    // `app.close()` runs Fastify's onClose hooks and, with
    // `forceCloseConnections`, drops the long-lived SSE streams instead of
    // waiting on them. The unref'd failsafe guarantees the process exits even if
    // close hangs for any reason — the port must be released no matter what.
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        app.log.info({ signal }, 'shutting down');
        setTimeout(() => process.exit(0), 3000).unref();
        app.close().then(
            () => process.exit(0),
            () => process.exit(0),
        );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    // Boot pin (docs/graph-lifecycle.md Step 4): once the bootstrap seeds +
    // migration have settled, load + pin every autonomous, non-stopped graph so
    // the headless running lane (unpaused Trigger timers) comes up without a
    // browser parked on the graph. `syncPin`/`load` guard on `loaded.has`, so a
    // graph the first FE request already activated isn't double-loaded — boot
    // ordering vs. that request is safe either way. Best-effort per graph: one
    // graph that fails to build mustn't abort pinning the rest.
    await app.bootstrapComplete;
    for (const g of await app.graphStore.list()) {
        if (!graphIsAutonomous(g) || g.stopped) continue;
        try {
            await app.runtimes.syncPin(g);
        } catch (err) {
            app.log.error({ err, graphId: g.id }, 'boot pin failed');
        }
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
