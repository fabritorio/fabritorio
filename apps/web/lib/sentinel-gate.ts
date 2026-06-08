export class SentinelGate {
    private snapshotMax: number | null = null;

    markSnapshotComplete(snapshotMax: number): void {
        this.snapshotMax = snapshotMax;
    }

    shouldPublish(seq: number): boolean {
        if (this.snapshotMax === null) return false;
        return seq > this.snapshotMax;
    }

    get armed(): boolean {
        return this.snapshotMax !== null;
    }
}
