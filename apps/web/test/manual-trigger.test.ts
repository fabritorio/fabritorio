import { describe, expect, it, vi } from 'vitest';
import type { TriggerNode } from '@fabritorio/types';
import type { FireTriggerResult, RunnerClient } from '../lib/runner-client';
import { canFireTrigger } from '../components/inspectors/l2/TriggerInspector';

function manualTrigger(overrides: Partial<TriggerNode> = {}): TriggerNode {
    return {
        id: 'manual-1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        trigger_kind: 'manual',
        instructions: 'Do the thing',
        ...overrides,
    };
}

describe('canFireTrigger', () => {
    it('allows firing a manual trigger that is not paused', () => {
        expect(canFireTrigger(manualTrigger())).toBe(true);
    });

    it('disables firing when the manual trigger is paused', () => {
        expect(canFireTrigger(manualTrigger({ paused: true }))).toBe(false);
    });

    it('only applies to manual triggers — cron/schedule cannot be hand-fired', () => {
        expect(canFireTrigger({ trigger_kind: 'cron' })).toBe(false);
        expect(canFireTrigger({ trigger_kind: 'schedule' })).toBe(false);
    });
});

describe('RunnerClient.fireTrigger wiring', () => {
    it('passes the instructions through as the fire message', async () => {
        const result: FireTriggerResult = {
            eventId: 'evt-1',
            source: 'graph-1',
            timestamp: 1234,
        };
        const fireTrigger = vi.fn().mockResolvedValue(result);
        const client = { fireTrigger } as unknown as RunnerClient;

        const out = await client.fireTrigger('graph-1', 'manual-1', { message: 'Do the thing' });

        expect(fireTrigger).toHaveBeenCalledWith('graph-1', 'manual-1', {
            message: 'Do the thing',
        });
        expect(out.eventId).toBe('evt-1');
    });
});
