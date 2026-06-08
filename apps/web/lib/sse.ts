import type { ObservabilityEvent } from '@fabritorio/types';

export interface ParsedSseFrame {
    event?: string;
    data: string;
}

export function splitSseStream(buffer: string): {
    frames: string[];
    rest: string;
} {
    const frames: string[] = [];
    let rest = buffer;
    while (true) {
        const idx = findFrameBoundary(rest);
        if (idx === -1) break;
        frames.push(rest.slice(0, idx.start));
        rest = rest.slice(idx.end);
    }
    return { frames, rest };
}

function findFrameBoundary(s: string): { start: number; end: number } | -1 {
    const a = s.indexOf('\n\n');
    const b = s.indexOf('\r\n\r\n');
    if (a === -1 && b === -1) return -1;
    if (a !== -1 && (b === -1 || a < b)) return { start: a, end: a + 2 };
    return { start: b, end: b + 4 };
}

export function parseSseFrame(raw: string): ParsedSseFrame | null {
    if (!raw) return null;
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return null;
    return { event: eventName, data: dataLines.join('\n') };
}

export function parseObservabilityEvent(raw: string): ObservabilityEvent | null {
    const parsed = parseSseFrame(raw);
    if (!parsed) return null;
    try {
        return JSON.parse(parsed.data) as ObservabilityEvent;
    } catch {
        return null;
    }
}
