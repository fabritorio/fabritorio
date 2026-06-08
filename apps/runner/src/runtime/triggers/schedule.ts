import type { ScheduleRecurrence } from '@fabritorio/types';
import type { IntervalScheduler, Scheduler, SchedulerHandle } from './cron.js';
import type { TriggerStrategy, TriggerStrategyFactory, TriggerStrategyHandle } from './strategy.js';

export interface ScheduleStrategyDeps {
    scheduler: Scheduler;
    intervalScheduler: IntervalScheduler;
}

export function createScheduleStrategyFactory(deps: ScheduleStrategyDeps): TriggerStrategyFactory {
    return ({ node, nodeId, fire }) => {
        if (node.trigger_kind !== 'schedule') {
            throw new Error(`schedule strategy: trigger ${nodeId} has kind="${node.trigger_kind}"`);
        }
        const at = node.at?.trim() ?? '';
        const recurrence = node.recurrence;
        if (at.length === 0 && !recurrence) {
            throw new Error(`trigger ${nodeId}: schedule requires \`at\` or \`recurrence\``);
        }

        const from = node.from?.trim() ?? '';
        const until = node.until?.trim() ?? '';
        const fromMs = from.length > 0 ? Date.parse(from) : null;
        const untilMs = until.length > 0 ? Date.parse(until) : null;

        const inWindow = (): boolean => {
            if (fromMs === null && untilMs === null) return true;
            const now = Date.now();
            if (fromMs !== null && now < fromMs) return false;
            if (untilMs !== null && now >= untilMs) return false;
            return true;
        };

        const tick = () => {
            if (!inWindow()) return;
            fire().catch(() => undefined);
        };

        const strategy: TriggerStrategy = {
            activate(): TriggerStrategyHandle {
                const handle = mount({ at, recurrence, nodeId, deps, tick });
                return {
                    deactivate() {
                        handle.stop();
                    },
                };
            },
        };
        return strategy;
    };
}

function mount(args: {
    at: string;
    recurrence: ScheduleRecurrence | undefined;
    nodeId: string;
    deps: ScheduleStrategyDeps;
    tick: () => void;
}): SchedulerHandle {
    if (args.at.length > 0) {
        if (Date.parse(args.at) < Date.now()) {
            return { stop: () => undefined };
        }
        return args.deps.scheduler.schedule(args.at, args.tick);
    }
    const rec = args.recurrence;
    if (!rec) {
        throw new Error(`schedule strategy: trigger ${args.nodeId} has no \`recurrence\``);
    }
    switch (rec.kind) {
        case 'interval': {
            const seconds = parseIsoDurationSeconds(rec.every);
            if (seconds === null || seconds < 1) {
                throw new Error(
                    `schedule strategy: \`every="${rec.every}"\` is not a valid duration`,
                );
            }
            const cronExpr = compileEveryToCron(seconds);
            if (cronExpr !== null) {
                return args.deps.scheduler.schedule(cronExpr, args.tick);
            }
            return args.deps.intervalScheduler.schedule(seconds * 1000, args.tick);
        }
        case 'daily': {
            const { h, m } = parseHhMm(rec.time);
            return args.deps.scheduler.schedule(`${m} ${h} * * *`, args.tick);
        }
        case 'weekly': {
            const { h, m } = parseHhMm(rec.time);
            if (rec.days.length === 0) {
                throw new Error(
                    `schedule strategy: weekly recurrence on trigger ${args.nodeId} has no days`,
                );
            }
            const dow = rec.days.join(',');
            return args.deps.scheduler.schedule(`${m} ${h} * * ${dow}`, args.tick);
        }
    }
}

function parseHhMm(time: string): { h: number; m: number } {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) {
        throw new Error(`schedule strategy: \`time="${time}"\` is not a valid HH:MM value`);
    }
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) {
        throw new Error(`schedule strategy: \`time="${time}"\` is out of range`);
    }
    return { h, m };
}

const ISO_DURATION_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function parseIsoDurationSeconds(s: string): number | null {
    const m = ISO_DURATION_RE.exec(s);
    if (!m) return null;
    const [, d, h, min, sec] = m;
    if (!d && !h && !min && !sec) return null;
    const days = d ? Number(d) : 0;
    const hours = h ? Number(h) : 0;
    const minutes = min ? Number(min) : 0;
    const seconds = sec ? Number(sec) : 0;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

const MINUTE_DIVISORS_OF_60: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]);
const HOUR_DIVISORS_OF_24: ReadonlySet<number> = new Set([1, 2, 3, 4, 6, 8, 12]);

export function compileEveryToCron(seconds: number): string | null {
    if (seconds < 60) return null;
    if (seconds < 3600) {
        if (seconds % 60 !== 0) return null;
        const minutes = seconds / 60;
        if (!MINUTE_DIVISORS_OF_60.has(minutes)) return null;
        return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
    }
    if (seconds < 86400) {
        if (seconds % 3600 !== 0) return null;
        const hours = seconds / 3600;
        if (!HOUR_DIVISORS_OF_24.has(hours)) return null;
        return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
    }
    if (seconds === 86400) return '0 0 * * *';
    return null;
}
