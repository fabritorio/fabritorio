const DEFAULT_PORT = 4000;
const DEFAULT_HOST = '127.0.0.1';

export interface RunnerConfig {
    port: number;
    host: string;
}

export function loadConfig(): RunnerConfig {
    const raw = process.env.PORT;
    let port = DEFAULT_PORT;
    if (raw !== undefined && raw !== '') {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
            throw new Error(`Invalid PORT value: ${raw}`);
        }
        port = parsed;
    }
    const hostRaw = process.env.HOST;
    const host = hostRaw !== undefined && hostRaw !== '' ? hostRaw : DEFAULT_HOST;
    return { port, host };
}

/**
 * Loopback bind hosts. `127.0.0.1` / `::1` are the literals; `0.0.0.0` / `::`
 * are the dangerous wildcard binds (`dev:lan`) — explicitly NOT loopback. A
 * resolved hostname (e.g. `localhost`) binds whatever it resolves to; we treat
 * the bare loopback literals as the only safe-by-default binds.
 */
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackBind(host: string): boolean {
    return LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase());
}
