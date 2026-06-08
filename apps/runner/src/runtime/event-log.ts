import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';

export type LoggedEvent = DispatchEvent | ObservabilityEvent;

export interface EventLog {
    appendDispatch(event: DispatchEvent): Promise<void>;
    appendObservability(event: ObservabilityEvent): Promise<void>;
    read(eventId: string): Promise<LoggedEvent[]>;
    delete(eventId: string): Promise<void>;
    readAll(): Promise<LoggedEvent[]>;
    flush(): Promise<void>;
}

export interface EventLogOptions {
    dir?: string;
}

export function resolveEventsDir(dir?: string): string {
    if (dir) return resolve(dir);
    const fromEnv = process.env.FABRITORIO_EVENTS_DIR;
    if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
    return join(homedir(), '.fabritorio', 'events');
}

const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidEventId(id: string): boolean {
    return EVENT_ID_PATTERN.test(id);
}

function arrivalTimeOf(event: LoggedEvent): number {
    if ('timestamp' in event && typeof event.timestamp === 'number') {
        return event.timestamp;
    }
    if ('ts' in event && typeof event.ts === 'string') {
        const parsed = Date.parse(event.ts);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

export function createEventLog(opts: EventLogOptions = {}): EventLog {
    const dir = resolveEventsDir(opts.dir);
    let writeChain: Promise<void> = Promise.resolve();
    let dirEnsured = false;

    async function ensureDir(): Promise<void> {
        if (dirEnsured) return;
        await mkdir(dir, { recursive: true });
        dirEnsured = true;
    }

    function pathFor(eventId: string): string {
        return join(dir, `${eventId}.jsonl`);
    }

    function appendLine(eventId: string, line: string): Promise<void> {
        const next = writeChain.then(async () => {
            await ensureDir();
            await appendFile(pathFor(eventId), `${line}\n`, 'utf8');
        });
        writeChain = next.catch(() => undefined);
        return next;
    }

    async function readFileLines(p: string): Promise<LoggedEvent[]> {
        let raw: string;
        try {
            raw = await readFile(p, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw err;
        }
        const out: LoggedEvent[] = [];
        for (const line of raw.split('\n')) {
            if (line.length === 0) continue;
            try {
                out.push(JSON.parse(line) as LoggedEvent);
            } catch {
                // Skip corrupt lines — best-effort replay.
            }
        }
        return out;
    }

    return {
        appendDispatch(event) {
            return appendLine(event.eventId, JSON.stringify(event));
        },
        appendObservability(event) {
            return appendLine(event.eventId, JSON.stringify(event));
        },
        async read(eventId) {
            if (!isValidEventId(eventId)) return [];
            return readFileLines(pathFor(eventId));
        },
        delete(eventId) {
            if (!isValidEventId(eventId)) return Promise.resolve();
            const next = writeChain.then(async () => {
                try {
                    await unlink(pathFor(eventId));
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                }
            });
            writeChain = next.catch(() => undefined);
            return next;
        },
        async readAll() {
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw err;
            }
            const all: LoggedEvent[] = [];
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
                const id = entry.name.slice(0, -'.jsonl'.length);
                if (!isValidEventId(id)) continue;
                const events = await readFileLines(join(dir, entry.name));
                all.push(...events);
            }
            all.sort((a, b) => arrivalTimeOf(a) - arrivalTimeOf(b));
            return all;
        },
        async flush() {
            await writeChain;
        },
    };
}
