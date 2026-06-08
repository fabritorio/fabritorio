import type { Graph, Node, NodeType } from '@fabritorio/types';
import type { GraphStore } from './store.js';

export interface RefConflict {
    refId: string;
    otherGraphId: string;
    otherNodeId: string;
}

export interface UniqueRefsCheck {
    ok: boolean;
    conflicts: RefConflict[];
}

export async function checkUniqueRefs(
    store: GraphStore,
    incoming: Pick<Graph, 'nodes'>,
    excludeGraphId: string | undefined,
): Promise<UniqueRefsCheck> {
    const all = await store.list();
    const usage = new Map<string, { graphId: string; nodeId: string }>();
    for (const g of all) {
        if (!g.id) continue;
        if (excludeGraphId && g.id === excludeGraphId) continue;
        for (const node of g.nodes) {
            const ref = refOf(node);
            if (!ref) continue;
            if (!usage.has(ref)) {
                usage.set(ref, { graphId: g.id, nodeId: node.id });
            }
        }
    }

    const conflicts: RefConflict[] = [];
    const seenInIncoming = new Set<string>();
    for (const node of incoming.nodes) {
        const ref = refOf(node);
        if (!ref) continue;
        if (seenInIncoming.has(ref)) {
            conflicts.push({
                refId: ref,
                otherGraphId: excludeGraphId ?? '(self)',
                otherNodeId: node.id,
            });
            continue;
        }
        seenInIncoming.add(ref);
        const site = usage.get(ref);
        if (site) {
            conflicts.push({
                refId: ref,
                otherGraphId: site.graphId,
                otherNodeId: site.nodeId,
            });
        }
    }
    return { ok: conflicts.length === 0, conflicts };
}

export function refOf(node: Node): string | null {
    if (node.type === 'native_agent' && typeof node.l1_graph_id === 'string' && node.l1_graph_id) {
        return node.l1_graph_id;
    }
    if ('ref_id' in node && typeof node.ref_id === 'string' && node.ref_id) {
        return node.ref_id;
    }
    return null;
}

export const AGENT_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
    'native_agent',
    'cli_agent',
    'go_claude_agent',
    'pi_agent',
]);

export function isAgentType(t: NodeType): boolean {
    return AGENT_NODE_TYPES.has(t);
}

export interface TopologyViolation {
    code:
        | 'trigger_inbound_from_agent'
        | 'schedule_missing_at_or_recurrence'
        | 'schedule_both_at_and_recurrence'
        | 'schedule_invalid_at'
        | 'schedule_invalid_every'
        | 'schedule_invalid_time'
        | 'schedule_invalid_days'
        | 'schedule_window_misordered'
        | 'schedule_window_without_recurrence';
    message: string;
    nodeId: string;
}

export interface TopologyCheck {
    ok: boolean;
    violations: TopologyViolation[];
}

export function checkTopology(graph: Pick<Graph, 'nodes' | 'edges'>): TopologyCheck {
    const typeById = new Map<string, NodeType>();
    for (const n of graph.nodes) typeById.set(n.id, n.type);

    const triggerInboundAgents = new Map<string, Set<string>>();

    const addTo = (m: Map<string, Set<string>>, key: string, value: string) => {
        let bucket = m.get(key);
        if (!bucket) {
            bucket = new Set();
            m.set(key, bucket);
        }
        bucket.add(value);
    };

    for (const edge of graph.edges) {
        const srcType = typeById.get(edge.source.node_id);
        const tgtType = typeById.get(edge.target.node_id);
        if (!srcType || !tgtType) continue;
        if (isAgentType(srcType) && tgtType === 'trigger') {
            addTo(triggerInboundAgents, edge.target.node_id, edge.source.node_id);
        }
    }

    const violations: TopologyViolation[] = [];
    for (const [triggerId, agents] of triggerInboundAgents) {
        const ids = [...agents].sort().join(', ');
        violations.push({
            code: 'trigger_inbound_from_agent',
            nodeId: triggerId,
            message: `trigger ${triggerId} is the target of an event-flow edge from agent(s) ${ids}; triggers fan out only — no reply path`,
        });
    }

    for (const n of graph.nodes) {
        if (n.type !== 'trigger') continue;
        if (n.trigger_kind !== 'schedule') continue;
        checkScheduleTrigger(n, violations);
    }

    return { ok: violations.length === 0, violations };
}

const ISO_TIMESTAMP_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const ISO_DURATION_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseIsoDurationSeconds(s: string): number | null {
    const m = ISO_DURATION_RE.exec(s);
    if (!m) return null;
    const [, d, h, min, sec] = m;
    if (!d && !h && !min && !sec) return null;
    const days = d ? Number(d) : 0;
    const hours = h ? Number(h) : 0;
    const minutes = min ? Number(min) : 0;
    const seconds = sec ? Number(sec) : 0;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function isValidIsoTimestamp(s: string): boolean {
    if (!ISO_TIMESTAMP_RE.test(s)) return false;
    const t = Date.parse(s);
    return !Number.isNaN(t);
}

function checkScheduleTrigger(
    node: Extract<Node, { type: 'trigger' }>,
    violations: TopologyViolation[],
): void {
    const hasAt = typeof node.at === 'string' && node.at.length > 0;
    const hasRecurrence = node.recurrence != null;
    const hasFrom = typeof node.from === 'string' && node.from.length > 0;
    const hasUntil = typeof node.until === 'string' && node.until.length > 0;

    if (!hasAt && !hasRecurrence) {
        violations.push({
            code: 'schedule_missing_at_or_recurrence',
            nodeId: node.id,
            message: `trigger ${node.id} is schedule-kind but has neither \`at\` nor \`recurrence\` set; one is required`,
        });
        return;
    }
    if (hasAt && hasRecurrence) {
        violations.push({
            code: 'schedule_both_at_and_recurrence',
            nodeId: node.id,
            message: `trigger ${node.id} sets both \`at\` and \`recurrence\`; schedule triggers are one-shot (\`at\`) xor recurring (\`recurrence\`)`,
        });
        return;
    }

    if (hasAt) {
        if (!isValidIsoTimestamp(node.at as string)) {
            violations.push({
                code: 'schedule_invalid_at',
                nodeId: node.id,
                message: `trigger ${node.id}: \`at="${node.at}"\` is not a valid ISO-8601 timestamp`,
            });
        }
        if (hasFrom || hasUntil) {
            violations.push({
                code: 'schedule_window_without_recurrence',
                nodeId: node.id,
                message: `trigger ${node.id} sets \`from\`/\`until\` alongside \`at\`; windowing only applies to recurring (\`recurrence\`) schedules`,
            });
        }
        return;
    }

    const rec = node.recurrence!;
    switch (rec.kind) {
        case 'interval': {
            const seconds = parseIsoDurationSeconds(rec.every ?? '');
            if (seconds === null) {
                violations.push({
                    code: 'schedule_invalid_every',
                    nodeId: node.id,
                    message: `trigger ${node.id}: \`every="${rec.every}"\` is not a valid ISO-8601 duration (e.g. "PT15M", "PT1H30M")`,
                });
                return;
            }
            if (seconds < 1) {
                violations.push({
                    code: 'schedule_invalid_every',
                    nodeId: node.id,
                    message: `trigger ${node.id}: \`every="${rec.every}"\` resolves to ${seconds}s; minimum recurrence is 1 second`,
                });
                return;
            }
            break;
        }
        case 'daily': {
            if (!HH_MM_RE.test(rec.time ?? '')) {
                violations.push({
                    code: 'schedule_invalid_time',
                    nodeId: node.id,
                    message: `trigger ${node.id}: daily \`time="${rec.time}"\` is not a valid HH:MM (00–23 : 00–59)`,
                });
                return;
            }
            break;
        }
        case 'weekly': {
            if (!HH_MM_RE.test(rec.time ?? '')) {
                violations.push({
                    code: 'schedule_invalid_time',
                    nodeId: node.id,
                    message: `trigger ${node.id}: weekly \`time="${rec.time}"\` is not a valid HH:MM (00–23 : 00–59)`,
                });
                return;
            }
            const days = rec.days;
            if (!Array.isArray(days) || days.length === 0) {
                violations.push({
                    code: 'schedule_invalid_days',
                    nodeId: node.id,
                    message: `trigger ${node.id}: weekly recurrence needs at least one weekday (0=Sun..6=Sat)`,
                });
                return;
            }
            const bad = days.some((d) => !Number.isInteger(d) || d < 0 || d > 6);
            if (bad) {
                violations.push({
                    code: 'schedule_invalid_days',
                    nodeId: node.id,
                    message: `trigger ${node.id}: weekly \`days=[${days.join(', ')}]\` must each be an integer 0–6 (Sun..Sat)`,
                });
                return;
            }
            break;
        }
    }

    if (hasFrom && !isValidIsoTimestamp(node.from as string)) {
        violations.push({
            code: 'schedule_invalid_at',
            nodeId: node.id,
            message: `trigger ${node.id}: \`from="${node.from}"\` is not a valid ISO-8601 timestamp`,
        });
        return;
    }
    if (hasUntil && !isValidIsoTimestamp(node.until as string)) {
        violations.push({
            code: 'schedule_invalid_at',
            nodeId: node.id,
            message: `trigger ${node.id}: \`until="${node.until}"\` is not a valid ISO-8601 timestamp`,
        });
        return;
    }
    if (hasFrom && hasUntil) {
        const f = Date.parse(node.from as string);
        const u = Date.parse(node.until as string);
        if (!(f < u)) {
            violations.push({
                code: 'schedule_window_misordered',
                nodeId: node.id,
                message: `trigger ${node.id}: \`from="${node.from}"\` must be strictly before \`until="${node.until}"\``,
            });
        }
    }
}

export function topologyMessage(violations: ReadonlyArray<TopologyViolation>): string {
    const first = violations[0];
    if (!first) return 'topology violation';
    const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : '';
    return `${first.message}${more}`;
}
