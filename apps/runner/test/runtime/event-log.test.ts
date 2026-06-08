import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, ObservabilityEvent } from '@fabritorio/types';
import { createEventLog } from '../../src/runtime/event-log.js';

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';

function dispatch(
    eventId: string,
    opts: { parentId?: string; source?: string; timestamp?: number } = {},
): DispatchEvent {
    return {
        eventId,
        source: opts.source ?? 'webchat:c1',
        timestamp: opts.timestamp ?? 1,
        messages: [{ role: 'user', content: 'hi' }],
        ...(opts.parentId ? { parentId: opts.parentId } : {}),
    };
}

function chunk(eventId: string, ts: string): ObservabilityEvent {
    return {
        type: 'llm.chunk',
        ts,
        eventId,
        parentId: eventId,
        node_id: 'm1',
        delta: 'x',
    };
}

describe('createEventLog', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-events-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('appends Dispatch + Observability to the same file keyed by eventId', async () => {
        const log = createEventLog({ dir });
        const root = dispatch(ROOT_ID);
        const obs = chunk(ROOT_ID, '2026-04-28T00:00:00.000Z');
        await log.appendDispatch(root);
        await log.appendObservability(obs);
        await log.flush();

        const back = await log.read(ROOT_ID);
        expect(back).toEqual([root, obs]);
        const raw = readFileSync(join(dir, `${ROOT_ID}.jsonl`), 'utf8');
        expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
    });

    it("child Dispatches go to their own file, not the parent's", async () => {
        const log = createEventLog({ dir });
        const root = dispatch(ROOT_ID);
        const child = dispatch(CHILD_ID, {
            parentId: ROOT_ID,
            source: 'agent:ag1',
            timestamp: 2,
        });
        await log.appendDispatch(root);
        await log.appendDispatch(child);
        await log.flush();

        expect(await log.read(ROOT_ID)).toEqual([root]);
        expect(await log.read(CHILD_ID)).toEqual([child]);
    });

    it('readAll returns every event sorted by arrival time across files', async () => {
        const log = createEventLog({ dir });
        const t0 = Date.parse('2026-04-28T00:00:00.000Z');
        const root = dispatch(ROOT_ID, { timestamp: t0 });
        const child = dispatch(CHILD_ID, {
            parentId: ROOT_ID,
            source: 'agent:ag1',
            timestamp: t0 + 200,
        });
        const obsEarly = chunk(ROOT_ID, '2026-04-28T00:00:00.150Z');
        await log.appendDispatch(child);
        await log.appendDispatch(root);
        await log.appendObservability(obsEarly);
        await log.flush();

        const all = await log.readAll();
        expect(all.map((e) => e.eventId)).toEqual([ROOT_ID, ROOT_ID, CHILD_ID]);
        expect(all[0]).toEqual(root);
        expect(all[1]).toEqual(obsEarly);
        expect(all[2]).toEqual(child);
    });

    it('read returns [] for unknown eventId and ignores invalid uuids', async () => {
        const log = createEventLog({ dir });
        expect(await log.read(ROOT_ID)).toEqual([]);
        expect(await log.read('not-a-uuid')).toEqual([]);
    });

    it('readAll skips corrupt lines and ignores non-uuid filenames', async () => {
        const log = createEventLog({ dir });
        await log.appendDispatch(dispatch(ROOT_ID));
        await log.flush();
        writeFileSync(
            join(dir, `${ROOT_ID}.jsonl`),
            `${JSON.stringify(dispatch(ROOT_ID))}\nnot-json\n`,
            'utf8',
        );
        writeFileSync(join(dir, 'not-a-uuid.jsonl'), 'garbage\n', 'utf8');

        const all = await log.readAll();
        expect(all).toHaveLength(1);
        expect(all[0]?.eventId).toBe(ROOT_ID);
    });

    it('readAll on a never-created dir returns []', async () => {
        const fresh = join(dir, 'never');
        const log = createEventLog({ dir: fresh });
        expect(await log.readAll()).toEqual([]);
    });

    it('delete removes the per-eventId file; a subsequent read returns []', async () => {
        const log = createEventLog({ dir });
        await log.appendDispatch(dispatch(ROOT_ID));
        await log.flush();
        expect(await log.read(ROOT_ID)).toHaveLength(1);

        await log.delete(ROOT_ID);
        await log.flush();
        expect(await log.read(ROOT_ID)).toEqual([]);
    });

    it('delete on an absent eventId is a no-op (no throw)', async () => {
        const log = createEventLog({ dir });
        await expect(log.delete(ROOT_ID)).resolves.toBeUndefined();
    });

    it('delete on an invalid eventId is a no-op', async () => {
        const log = createEventLog({ dir });
        await expect(log.delete('not-a-uuid')).resolves.toBeUndefined();
    });
});
