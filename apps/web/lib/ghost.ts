export const GHOST_PREFIX = '__ghost__:';

export function isGhostId(id: string | null | undefined): boolean {
    return typeof id === 'string' && id.startsWith(GHOST_PREFIX);
}

export function stripGhostPrefix(id: string): string {
    return id.startsWith(GHOST_PREFIX) ? id.slice(GHOST_PREFIX.length) : id;
}

const GHOST_POSITIONS_KEY_PREFIX = 'fabritorio:ghost-positions:';

export type GhostPositions = Record<string, { x: number; y: number }>;

export function loadGhostPositions(l1GraphId: string): GhostPositions {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(`${GHOST_POSITIONS_KEY_PREFIX}${l1GraphId}`);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed as GhostPositions;
    } catch {
        return {};
    }
}

export function saveGhostPositions(l1GraphId: string, positions: GhostPositions): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(
            `${GHOST_POSITIONS_KEY_PREFIX}${l1GraphId}`,
            JSON.stringify(positions),
        );
    } catch {
        // localStorage can throw under quota / private mode — silently no-op so
        // a failed persist doesn't break the drag experience for the session.
    }
}

const GHOSTS_HIDDEN_KEY_PREFIX = 'fabritorio:ghosts-hidden:';

export function loadGhostsHidden(l1GraphId: string): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(`${GHOSTS_HIDDEN_KEY_PREFIX}${l1GraphId}`) === '1';
    } catch {
        return false;
    }
}

export function saveGhostsHidden(l1GraphId: string, hidden: boolean): void {
    if (typeof window === 'undefined') return;
    try {
        if (hidden) {
            window.localStorage.setItem(`${GHOSTS_HIDDEN_KEY_PREFIX}${l1GraphId}`, '1');
        } else {
            window.localStorage.removeItem(`${GHOSTS_HIDDEN_KEY_PREFIX}${l1GraphId}`);
        }
    } catch {
        // Same rationale as saveGhostPositions — a failed persist shouldn't
        // break the in-session toggle.
    }
}
