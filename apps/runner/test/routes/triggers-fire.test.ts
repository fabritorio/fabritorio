import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchEvent, Graph } from '@fabritorio/types';
import { buildServer } from '../../src/server.js';
import { createGraphStore } from '../../src/graphs/store.js';
import { createEventBus } from '../../src/runtime/event-bus.js';
import { createGraphRuntimeRegistry, createNodeRegistry } from '../../src/runtime/graph-runtime.js';
import { createTriggerBinding } from '../../src/runtime/bindings/trigger.js';
import { createTriggerStrategyRegistry } from '../../src/runtime/triggers/strategy.js';
import { createManualStrategyFactory } from '../../src/runtime/triggers/manual.js';
import { createManualTriggerRegistry } from '../../src/runtime/triggers/manual-registry.js';
import { inject } from '../helpers/inject.js';

const TRIGGER_ID = 'trg';
const AGENT_ID = 'ag';

function manualTriggerGraph(opts: {
    instructions?: string;
    paused?: boolean;
}): Omit<Graph, 'id' | 'created_at' | 'updated_at'> {
    return {
        kind: 'l2',
        name: 'manual-fire',
        nodes: [
            {
                id: TRIGGER_ID,
                type: 'trigger',
                trigger_kind: 'manual',
                position: { x: 0, y: 0 },
                ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
                ...(opts.paused !== undefined ? { paused: opts.paused } : {}),
            },
            {
                id: AGENT_ID,
                type: 'native_agent',
                l1_graph_id: '00000000-0000-4000-8000-000000000000',
                position: { x: 200, y: 0 },
            },
        ],
        edges: [
            {
                id: 'e-trg-ag',
                source: { node_id: TRIGGER_ID, port_id: 'out' },
                target: { node_id: AGENT_ID, port_id: 'in' },
            },
        ],
    };
}

interface BootResult {
    app: ReturnType<typeof buildServer>;
    bus: ReturnType<typeof createEventBus>;
    inbox: DispatchEvent[];
    graphId: string;
    cleanup(): Promise<void>;
}

async function bootWithManualTrigger(
    dir: string,
    opts: { instructions?: string; paused?: boolean },
): Promise<BootResult> {
    const graphStore = createGraphStore({ dir });
    const bus = createEventBus();
    const manualTriggers = createManualTriggerRegistry();

    const strategies = createTriggerStrategyRegistry();
    strategies.register('manual', createManualStrategyFactory({ registry: manualTriggers }));

    const inbox: DispatchEvent[] = [];
    const nodes = createNodeRegistry();
    nodes.register('trigger', createTriggerBinding({ strategies }));
    nodes.register('native_agent', {
        receiver: () => (event) => {
            inbox.push(event);
        },
    });

    const runtimes = createGraphRuntimeRegistry({ bus, nodes });
    const app = buildServer({ logger: false, graphStore, bus, runtimes, nodes, manualTriggers });

    const create = await inject(app, {
        method: 'POST',
        url: '/api/graphs',
        payload: manualTriggerGraph(opts),
    });
    const graphId = (create.json() as { graph: Graph }).graph.id!;
    const load = await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/load` });
    if (load.statusCode !== 200) {
        throw new Error(`load failed: ${load.statusCode} ${load.body}`);
    }

    return {
        app,
        bus,
        inbox,
        graphId,
        async cleanup() {
            await inject(app, { method: 'POST', url: `/api/graphs/${graphId}/unload` });
            await app.close();
        },
    };
}

describe('POST /triggers/:graphId/:nodeId/fire', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fabritorio-fire-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('fires a loaded manual trigger → 202 with eventId and emits the dispatch', async () => {
        const boot = await bootWithManualTrigger(dir, { instructions: 'run the report' });
        try {
            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/fire`,
            });
            expect(res.statusCode).toBe(202);
            const body = res.json() as { eventId: string; source: string; timestamp: number };
            expect(body.source).toBe(`trigger:${TRIGGER_ID}`);
            expect(typeof body.eventId).toBe('string');

            await new Promise((r) => setImmediate(r));
            expect(boot.inbox).toHaveLength(1);
            expect(boot.inbox[0]!.eventId).toBe(body.eventId);
            expect(boot.inbox[0]!.messages).toEqual([{ role: 'user', content: 'run the report' }]);
        } finally {
            await boot.cleanup();
        }
    });

    it('a fired run shows up in the trigger run history (/runs)', async () => {
        const boot = await bootWithManualTrigger(dir, { instructions: 'run the report' });
        try {
            const fire = await inject(boot.app, {
                method: 'POST',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/fire`,
            });
            expect(fire.statusCode).toBe(202);
            const { eventId } = fire.json() as { eventId: string };

            const runs = await inject(boot.app, {
                method: 'GET',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/runs`,
            });
            expect(runs.statusCode).toBe(200);
            const body = runs.json() as { source: string; runs: { eventId: string }[] };
            expect(body.source).toBe(`trigger:${TRIGGER_ID}`);
            expect(body.runs.map((r) => r.eventId)).toContain(eventId);
        } finally {
            await boot.cleanup();
        }
    });

    it('a message in the body overrides the stored instructions', async () => {
        const boot = await bootWithManualTrigger(dir, { instructions: 'stored prompt' });
        try {
            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/fire`,
                payload: { message: 'override prompt' },
            });
            expect(res.statusCode).toBe(202);

            await new Promise((r) => setImmediate(r));
            expect(boot.inbox).toHaveLength(1);
            expect(boot.inbox[0]!.messages).toEqual([{ role: 'user', content: 'override prompt' }]);
        } finally {
            await boot.cleanup();
        }
    });

    it('404s when the manual trigger node is unknown', async () => {
        const boot = await bootWithManualTrigger(dir, { instructions: 'go' });
        try {
            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/triggers/${boot.graphId}/no-such-node/fire`,
            });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ error: 'trigger node not found' });
        } finally {
            await boot.cleanup();
        }
    });

    it('404s with `trigger not loaded` when the manual trigger is paused (never registered)', async () => {
        const boot = await bootWithManualTrigger(dir, { instructions: 'go', paused: true });
        try {
            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/fire`,
            });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ error: 'trigger not loaded' });
        } finally {
            await boot.cleanup();
        }
    });

    it('404s when the graph is not loaded', async () => {
        const boot = await bootWithManualTrigger(dir, { instructions: 'go' });
        try {
            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/triggers/00000000-0000-4000-8000-deadbeefdead/${TRIGGER_ID}/fire`,
            });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ error: 'graph not loaded' });
        } finally {
            await boot.cleanup();
        }
    });

    it('400 `content required` when neither instructions nor message provide content', async () => {
        const boot = await bootWithManualTrigger(dir, {});
        try {
            const res = await inject(boot.app, {
                method: 'POST',
                url: `/api/triggers/${boot.graphId}/${TRIGGER_ID}/fire`,
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ error: 'content required' });
            expect(boot.inbox).toHaveLength(0);
        } finally {
            await boot.cleanup();
        }
    });
});
