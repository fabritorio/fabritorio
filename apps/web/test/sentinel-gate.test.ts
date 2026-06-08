import { describe, expect, it } from 'vitest';
import { SentinelGate } from '../lib/sentinel-gate';

describe('SentinelGate', () => {
    it('holds everything to store-only before the sentinel lands', () => {
        const gate = new SentinelGate();
        expect(gate.armed).toBe(false);
        expect(gate.shouldPublish(0)).toBe(false);
        expect(gate.shouldPublish(9999)).toBe(false);
    });

    it('publishes only frames past the snapshot boundary once armed', () => {
        const gate = new SentinelGate();
        gate.markSnapshotComplete(4);
        expect(gate.armed).toBe(true);
        expect(gate.shouldPublish(0)).toBe(false);
        expect(gate.shouldPublish(4)).toBe(false);
        expect(gate.shouldPublish(5)).toBe(true);
        expect(gate.shouldPublish(6)).toBe(true);
    });

    it('treats an empty snapshot (snapshotMax = -1) as: every live frame publishes', () => {
        const gate = new SentinelGate();
        gate.markSnapshotComplete(-1);
        expect(gate.shouldPublish(0)).toBe(true);
        expect(gate.shouldPublish(1)).toBe(true);
    });

    it('re-arms to the latest boundary (remount self-heal)', () => {
        const gate = new SentinelGate();
        gate.markSnapshotComplete(2);
        expect(gate.shouldPublish(3)).toBe(true);
        gate.markSnapshotComplete(10);
        expect(gate.shouldPublish(3)).toBe(false);
        expect(gate.shouldPublish(11)).toBe(true);
    });
});
