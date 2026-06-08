import type { DispatchEvent, LlmChunkEvent, ObservabilityEvent } from '@fabritorio/types';

export type LogEntry = DispatchEvent | ObservabilityEvent;

export type SourceCategory = 'all' | 'channel' | 'trigger' | 'agent';

export type EventRow =
    | {
          kind: 'event';
          ev: ObservabilityEvent;
          index: number;
          depth: number;
      }
    | {
          kind: 'dispatch';
          ev: DispatchEvent;
          index: number;
          depth: number;
          isRoot: boolean;
      }
    | {
          kind: 'chunk-group';
          stream_kind: 'content' | 'reasoning';
          first: LlmChunkEvent;
          last: LlmChunkEvent;
          count: number;
          accumulated: string;
          index: number;
          depth: number;
      };

export interface DispatchGroup {
    root: DispatchEvent;
    rootIndex: number;
    category: Exclude<SourceCategory, 'all'>;
    rows: EventRow[];
}

export function rowKey(row: EventRow): number {
    return row.index;
}

export function isDispatchEvent(ev: LogEntry): ev is DispatchEvent {
    return !('type' in ev) && typeof (ev as DispatchEvent).timestamp === 'number';
}

export function categoryOfSource(source: string): Exclude<SourceCategory, 'all'> {
    if (source.startsWith('webchat:') || source.startsWith('channel:')) {
        return 'channel';
    }
    if (source.startsWith('trigger:')) return 'trigger';
    return 'agent';
}

export function buildDispatchGroups(events: ReadonlyArray<LogEntry>): DispatchGroup[] {
    const groups: DispatchGroup[] = [];
    const groupForEventId = new Map<string, DispatchGroup>();
    const buckets = new Map<DispatchGroup, Array<{ ev: LogEntry; index: number; depth: number }>>();

    events.forEach((ev, index) => {
        if (isDispatchEvent(ev)) {
            if (!ev.parentId) {
                if (groupForEventId.has(ev.eventId)) return;
                const group: DispatchGroup = {
                    root: ev,
                    rootIndex: index,
                    category: categoryOfSource(ev.source),
                    rows: [],
                };
                groups.push(group);
                groupForEventId.set(ev.eventId, group);
                buckets.set(group, []);
                return;
            }
            const parentGroup = groupForEventId.get(ev.parentId);
            if (!parentGroup) return;
            groupForEventId.set(ev.eventId, parentGroup);
            buckets.get(parentGroup)!.push({ ev, index, depth: 1 });
            return;
        }
        const group = groupForEventId.get(ev.eventId);
        if (!group) return;
        const depth = ev.parentId && ev.parentId !== group.root.eventId ? 2 : 1;
        buckets.get(group)!.push({ ev, index, depth });
    });

    for (const group of groups) {
        const items = buckets.get(group) ?? [];
        items.sort((a, b) => tsOf(a.ev) - tsOf(b.ev));
        for (const item of items) pushRow(group.rows, item);
    }
    return groups;
}

function pushRow(rows: EventRow[], item: { ev: LogEntry; index: number; depth: number }): void {
    const { ev, index, depth } = item;
    if (isDispatchEvent(ev)) {
        rows.push({ kind: 'dispatch', ev, index, depth, isRoot: !ev.parentId });
        return;
    }
    if (ev.type === 'llm.chunk') {
        const streamKind: 'content' | 'reasoning' = ev.kind ?? 'content';
        const last = rows[rows.length - 1];
        if (
            last &&
            last.kind === 'chunk-group' &&
            last.stream_kind === streamKind &&
            last.depth === depth
        ) {
            last.count += 1;
            last.accumulated += ev.delta;
            last.last = ev;
            return;
        }
        rows.push({
            kind: 'chunk-group',
            stream_kind: streamKind,
            first: ev,
            last: ev,
            count: 1,
            accumulated: ev.delta,
            index,
            depth,
        });
        return;
    }
    rows.push({ kind: 'event', ev, index, depth });
}

function tsOf(ev: LogEntry): number {
    if (isDispatchEvent(ev)) return ev.timestamp;
    return Date.parse(ev.ts);
}

export function filterGroups(
    groups: ReadonlyArray<DispatchGroup>,
    category: SourceCategory,
): DispatchGroup[] {
    if (category === 'all') return [...groups];
    return groups.filter((g) => g.category === category);
}

export function labelForRow(row: EventRow): string {
    if (row.kind === 'dispatch') {
        return row.isRoot ? `dispatch.${categoryOfSource(row.ev.source)}` : 'dispatch.reply';
    }
    if (row.kind === 'chunk-group') {
        return row.stream_kind === 'reasoning'
            ? `llm.thinking×${row.count}`
            : `llm.chunk×${row.count}`;
    }
    return row.ev.type;
}

export function summarizeEvent(ev: ObservabilityEvent): string {
    switch (ev.type) {
        case 'llm.request': {
            const msgs = ev.messages.length;
            const tools = ev.tools?.length ?? 0;
            const toolPart = tools > 0 ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : '';
            return `${ev.model} · ${msgs} msg${msgs === 1 ? '' : 's'}${toolPart}`;
        }
        case 'llm.chunk':
            return JSON.stringify(ev.delta);
        case 'llm.response': {
            const tc = ev.tool_calls?.length ?? 0;
            const tcPart = tc > 0 ? ` · ${tc} tool call${tc === 1 ? '' : 's'}` : '';
            const reasoningPart = ev.reasoning ? ` · ${ev.reasoning.length} thinking chars` : '';
            return `${ev.finish_reason}${tcPart}${reasoningPart} — ${truncate(ev.content, 200)}`;
        }
        case 'tool.called': {
            const argKeys = Object.keys(ev.args);
            const sig = argKeys.length === 0 ? '' : argKeys.join(', ');
            return `${ev.tool_name}(${sig})`;
        }
        case 'tool.result': {
            const body =
                ev.exit_code === 0
                    ? truncate(ev.stdout, 200)
                    : truncate(ev.stderr || ev.stdout, 200);
            return `exit=${ev.exit_code} · ${body}`;
        }
        case 'gateway.received': {
            const n = ev.messages.length;
            return `${ev.source} · ${n} msg${n === 1 ? '' : 's'}`;
        }
        case 'output.emitted': {
            const n = ev.messages.length;
            return `${ev.port} · ${n} msg${n === 1 ? '' : 's'}`;
        }
        case 'workspace.file':
            return `${ev.action} ${ev.path}`;
        case 'chain.stopped':
            return ev.reason ?? 'stopped';
        case 'model_router.fell_through':
            return `${ev.from_model_id} → ${ev.to_model_id} (${ev.reason})`;
        default:
            return '';
    }
}

export function summarizeDispatch(ev: DispatchEvent): string {
    const userMsg = ev.messages.find((m) => m.role === 'user');
    const assistantMsg = ev.messages.find((m) => m.role === 'assistant');
    const head = userMsg?.content ?? assistantMsg?.content ?? '';
    return `${ev.source}${head ? ` — ${truncate(head, 200)}` : ''}`;
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
