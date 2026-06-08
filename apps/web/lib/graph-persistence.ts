'use client';

const ID_STORAGE_KEY = 'fabritorio:web:current-graph-id';

export function loadCurrentGraphId(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(ID_STORAGE_KEY);
        if (raw && raw.length > 0) return raw;
        return null;
    } catch {
        return null;
    }
}

export function storeCurrentGraphId(id: string | null): void {
    if (typeof window === 'undefined') return;
    try {
        if (id === null) window.localStorage.removeItem(ID_STORAGE_KEY);
        else window.localStorage.setItem(ID_STORAGE_KEY, id);
    } catch {
        /* quota / access denied — ignore */
    }
}
