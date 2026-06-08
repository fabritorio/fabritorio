import { Cron } from 'croner';
import type { TriggerStrategy, TriggerStrategyFactory, TriggerStrategyHandle } from './strategy.js';

export interface Scheduler {
    schedule(expression: string, callback: () => void): SchedulerHandle;
}

export interface SchedulerHandle {
    stop(): void;
}

export interface IntervalScheduler {
    schedule(ms: number, callback: () => void): SchedulerHandle;
}

export function createCronerScheduler(): Scheduler {
    return {
        schedule(expression, callback) {
            const job = new Cron(expression, {}, () => {
                try {
                    callback();
                } catch {
                    // A throw inside the tick must not cascade out and tear down the
                    // job — croner would log it and keep firing. The trigger binding
                    // is responsible for converting fire failures into observability;
                    // we just isolate the timer here.
                }
            });
            return {
                stop() {
                    job.stop();
                },
            };
        },
    };
}

export function createIntervalScheduler(): IntervalScheduler {
    return {
        schedule(ms, callback) {
            const handle = setInterval(() => {
                try {
                    callback();
                } catch {
                    // Same rationale as the cron wrapper: isolate timer ownership
                    // from the handler's failure modes.
                }
            }, ms);
            return {
                stop() {
                    clearInterval(handle);
                },
            };
        },
    };
}

export interface CronStrategyDeps {
    scheduler: Scheduler;
}

export function createCronStrategyFactory(deps: CronStrategyDeps): TriggerStrategyFactory {
    return ({ node, nodeId, fire }) => {
        if (node.trigger_kind !== 'cron') {
            throw new Error(`cron strategy: trigger ${nodeId} has kind="${node.trigger_kind}"`);
        }
        const expression = node.expression?.trim() ?? '';
        if (expression.length === 0) {
            throw new Error(`trigger ${nodeId}: cron expression is required`);
        }
        const strategy: TriggerStrategy = {
            activate(): TriggerStrategyHandle {
                const handle = deps.scheduler.schedule(expression, () => {
                    fire().catch(() => undefined);
                });
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
