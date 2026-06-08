const tails = new Map<string, Promise<unknown>>();

export async function withGraphLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(id);
    const myTurn = prev ? prev.catch(() => undefined).then(() => fn()) : fn();
    const swallowed = myTurn.catch(() => undefined);
    tails.set(id, swallowed);
    try {
        return await myTurn;
    } finally {
        if (tails.get(id) === swallowed) {
            tails.delete(id);
        }
    }
}

export function activeLockCount(): number {
    return tails.size;
}
