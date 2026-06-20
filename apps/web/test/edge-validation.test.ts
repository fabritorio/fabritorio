import { describe, it, expect } from 'vitest';
import type { Node } from '@fabritorio/types';
import {
    canConnect,
    canConnectHandler,
    canConnectL2,
    probeAttachCheck,
    resolvePortsL1,
    validateL1Graph,
    validateL2Graph,
} from '../lib/edge-validation';

const model: Node = {
    id: 'm',
    type: 'model',
    position: { x: 0, y: 0 },
    provider: 'openai',
    model_id: 'gpt-x',
};

const gateway: Node = {
    id: 'g',
    type: 'gateway',
    position: { x: 0, y: 0 },
};

const skill: Node = {
    id: 's',
    type: 'skill',
    position: { x: 0, y: 0 },
    name: 'planner',
};

const skill2: Node = {
    id: 's2',
    type: 'skill',
    position: { x: 0, y: 0 },
    name: 'summarizer',
};

describe('canConnect', () => {
    it('allows Gateway → Model', () => {
        expect(canConnect([model, gateway], 'g', 'm').ok).toBe(true);
    });

    it('allows Skill → Model', () => {
        expect(canConnect([model, skill], 's', 'm').ok).toBe(true);
    });

    it('rejects Skill → Gateway', () => {
        const res = canConnect([gateway, skill], 's', 'g');
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/Skill must connect to a Handler or Model/);
    });

    it('rejects Skill → Skill', () => {
        const res = canConnect([skill, skill2], 's', 's2');
        expect(res.ok).toBe(false);
    });

    it('rejects inbound to a Skill node', () => {
        const res = canConnect([model, skill], 'm', 's');
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/no inbound connections/);
    });

    it('rejects self-loop', () => {
        const res = canConnect([model], 'm', 'm');
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('self-loop');
    });

    it('rejects unknown node ids', () => {
        const res = canConnect([model], 'ghost', 'm');
        expect(res.ok).toBe(false);
    });

    describe('with a Handler on canvas', () => {
        const handler: Node = {
            id: 'h',
            type: 'handler',
            position: { x: 0, y: 0 },
        };
        const withHandler = [model, gateway, skill, handler];

        it('allows Gateway → Handler', () => {
            expect(canConnect(withHandler, 'g', 'h').ok).toBe(true);
        });

        it('allows Handler → Model', () => {
            expect(canConnect(withHandler, 'h', 'm').ok).toBe(true);
        });

        it('allows Skill → Handler', () => {
            expect(canConnect(withHandler, 's', 'h').ok).toBe(true);
        });

        it('allows Gateway → Model when a Handler exists', () => {
            expect(canConnect(withHandler, 'g', 'm').ok).toBe(true);
        });

        it('allows Skill → Model when a Handler exists', () => {
            expect(canConnect(withHandler, 's', 'm').ok).toBe(true);
        });

        it('rejects Handler → Gateway', () => {
            const res = canConnect(withHandler, 'h', 'g');
            expect(res.ok).toBe(false);
        });
    });

    describe('with a Handler carrying max_iterations on canvas', () => {
        const loop: Node = {
            id: 'lh',
            type: 'handler',
            position: { x: 0, y: 0 },
            max_iterations: 5,
        };
        const withLoop = [model, gateway, skill, loop];

        it('allows Gateway → Handler', () => {
            expect(canConnect(withLoop, 'g', 'lh').ok).toBe(true);
        });

        it('allows Handler → Model', () => {
            expect(canConnect(withLoop, 'lh', 'm').ok).toBe(true);
        });

        it('allows Skill → Handler', () => {
            expect(canConnect(withLoop, 's', 'lh').ok).toBe(true);
        });

        it('allows Gateway → Model when a Handler exists (palette-driven; phase 5.6)', () => {
            expect(canConnect(withLoop, 'g', 'm').ok).toBe(true);
        });
    });

    describe('with Tool nodes', () => {
        const tool: Node = {
            id: 't',
            type: 'tool',
            position: { x: 0, y: 0 },
            tool_name: 'read_file',
        };

        it('allows Tool → Model in a bare-Model graph', () => {
            expect(canConnect([model, tool], 't', 'm').ok).toBe(true);
        });

        it('rejects Tool → non-Model in a bare-Model graph', () => {
            const res = canConnect([gateway, tool], 't', 'g');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/Tool must connect to a Handler, Model, or Permission gate/);
        });

        it('rejects Model → Tool — Model has no outbound on L1', () => {
            const res = canConnect([model, tool], 'm', 't');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/Model nodes have no outbound connections/);
        });

        it('allows Tool → Handler and Tool → Model when a handler is on canvas (palette-driven; phase 5.6)', () => {
            const handler: Node = {
                id: 'h',
                type: 'handler',
                position: { x: 0, y: 0 },
            };
            expect(canConnect([model, handler, tool], 't', 'h').ok).toBe(true);
            expect(canConnect([model, handler, tool], 't', 'm').ok).toBe(true);
        });
    });

    describe('port-kind validation', () => {
        const handler: Node = {
            id: 'h',
            type: 'handler',
            position: { x: 0, y: 0 },
        };

        it('rejects mismatched port kinds', () => {
            const res = canConnect([handler, skill], 's', 'h', 'skill-out', 'gateway-in');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/reference source can't connect to event/);
        });

        it('allows matching reference ports', () => {
            const res = canConnect([handler, skill], 's', 'h', 'skill-out', 'skills-in');
            expect(res.ok).toBe(true);
        });

        it('allows matching event ports', () => {
            const res = canConnect([handler, gateway], 'g', 'h', 'gateway-out', 'gateway-in');
            expect(res.ok).toBe(true);
        });

        it('falls back to topology rules when ports are absent', () => {
            expect(canConnect([handler, skill], 's', 'h').ok).toBe(true);
            expect(canConnect([model, skill], 'm', 's').ok).toBe(false);
        });
    });

    describe('resolvePortsL1', () => {
        const handler: Node = {
            id: 'h',
            type: 'handler',
            position: { x: 0, y: 0 },
        };

        it('back-fills canonical ports for unported wires', () => {
            const ports = resolvePortsL1([handler, skill], 's', 'h');
            expect(ports.source_port).toBe('skill-out');
            expect(ports.target_port).toBe('skills-in');
        });

        it('preserves explicit port ids', () => {
            const ports = resolvePortsL1([handler, skill], 's', 'h', 'skill-out', 'skills-in');
            expect(ports.source_port).toBe('skill-out');
            expect(ports.target_port).toBe('skills-in');
        });

        it('resolves Handler→Model to model-out / model-in', () => {
            const ports = resolvePortsL1([handler, model], 'h', 'm');
            expect(ports.source_port).toBe('model-out');
            expect(ports.target_port).toBe('model-in');
        });

        it('resolves bare-model Skill→Model to skill-out / skills-in', () => {
            const ports = resolvePortsL1([model, skill], 's', 'm');
            expect(ports.source_port).toBe('skill-out');
            expect(ports.target_port).toBe('skills-in');
        });
    });

    describe('L2 canConnectL2', () => {
        const channel: Node = {
            id: 'c',
            type: 'channel',
            position: { x: 0, y: 0 },
            channel_kind: 'webchat',
        };
        const trigger: Node = {
            id: 'tg',
            type: 'trigger',
            position: { x: 0, y: 0 },
            trigger_kind: 'manual',
        };
        const native: Node = {
            id: 'na',
            type: 'native_agent',
            position: { x: 0, y: 0 },
            l1_graph_id: '',
        };
        const native2: Node = {
            id: 'na2',
            type: 'native_agent',
            position: { x: 0, y: 0 },
            l1_graph_id: '',
        };
        const memory: Node = {
            id: 'mem',
            type: 'memory',
            position: { x: 0, y: 0 },
            storage: 'in_memory',
            storage_kind: 'kv',
            handling: 'full_history',
            tool_access: 'none',
        };
        const l1Tool: Node = {
            id: 't',
            type: 'tool',
            position: { x: 0, y: 0 },
            tool_name: 'read',
        };

        it('allows Channel → NativeAgent', () => {
            expect(canConnectL2([channel, native], 'c', 'na').ok).toBe(true);
        });

        it('allows NativeAgent → Channel reply', () => {
            expect(canConnectL2([channel, native], 'na', 'c').ok).toBe(true);
        });

        it('allows Trigger → NativeAgent', () => {
            expect(canConnectL2([trigger, native2], 'tg', 'na2').ok).toBe(true);
        });

        it('allows Memory → NativeAgent', () => {
            expect(canConnectL2([memory, native], 'mem', 'na').ok).toBe(true);
        });

        it('rejects Memory → Channel (Memory only attaches to Agents)', () => {
            const res = canConnectL2([memory, channel], 'mem', 'c');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/Memory only attaches/);
        });

        it('rejects L1 Tool on an L2 canvas', () => {
            const res = canConnectL2([native2, l1Tool], 't', 'na2');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/L1 nodes belong inside/);
        });

        it('rejects ModelRouter on an L2 canvas', () => {
            const router: Node = {
                id: 'r',
                type: 'model_router',
                position: { x: 0, y: 0 },
                policy: 'failover',
            };
            const res = canConnectL2([router, native], 'r', 'na');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/L1 nodes belong inside/);
        });

        it('rejects Trigger as a sink', () => {
            const res = canConnectL2([native, trigger], 'na', 'tg');
            expect(res.ok).toBe(false);
        });

        it('allows Agent → Agent (ask_agent wire)', () => {
            expect(canConnectL2([native, native2], 'na', 'na2').ok).toBe(true);
            expect(canConnectL2([native2, native], 'na2', 'na').ok).toBe(true);
        });

        it('rejects Channel → Channel', () => {
            const channel2: Node = { ...channel, id: 'c2' };
            const res = canConnectL2([channel, channel2], 'c', 'c2');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/Channel publishes/);
        });
    });

    describe('validateL1Graph', () => {
        it('flags missing Gateway', () => {
            const out: Node = { id: 'o', type: 'output', position: { x: 0, y: 0 } };
            const issues = validateL1Graph([out]);
            expect(issues.some((i) => /Gateway/.test(i))).toBe(true);
        });

        it('flags duplicate Gateway', () => {
            const g1: Node = { id: 'g1', type: 'gateway', position: { x: 0, y: 0 } };
            const g2: Node = { id: 'g2', type: 'gateway', position: { x: 0, y: 0 } };
            const out: Node = { id: 'o', type: 'output', position: { x: 0, y: 0 } };
            const issues = validateL1Graph([g1, g2, out]);
            expect(issues.some((i) => /only one Gateway/.test(i))).toBe(true);
        });

        it('flags missing Output', () => {
            const g: Node = { id: 'g', type: 'gateway', position: { x: 0, y: 0 } };
            const issues = validateL1Graph([g]);
            expect(issues.some((i) => /Output/.test(i))).toBe(true);
        });

        it('passes with one Gateway and one Output', () => {
            const g: Node = { id: 'g', type: 'gateway', position: { x: 0, y: 0 } };
            const out: Node = { id: 'o', type: 'output', position: { x: 0, y: 0 } };
            expect(validateL1Graph([g, out])).toEqual([]);
        });
    });

    describe('validateL2Graph', () => {
        it('passes a clean Channel/Native/Memory graph', () => {
            const channel: Node = {
                id: 'c',
                type: 'channel',
                position: { x: 0, y: 0 },
                channel_kind: 'webchat',
            };
            const native: Node = {
                id: 'na',
                type: 'native_agent',
                position: { x: 0, y: 0 },
                l1_graph_id: '',
            };
            const memory: Node = {
                id: 'mem',
                type: 'memory',
                position: { x: 0, y: 0 },
                storage: 'in_memory',
                storage_kind: 'kv',
                handling: 'full_history',
                tool_access: 'none',
            };
            expect(
                validateL2Graph(
                    [channel, native, memory],
                    [
                        { source: { node_id: 'c' }, target: { node_id: 'na' } },
                        { source: { node_id: 'na' }, target: { node_id: 'c' } },
                        { source: { node_id: 'mem' }, target: { node_id: 'na' } },
                    ],
                ),
            ).toEqual([]);
        });
    });

    describe('with Model Router', () => {
        const handler: Node = {
            id: 'h',
            type: 'handler',
            position: { x: 0, y: 0 },
        };
        const router: Node = {
            id: 'r',
            type: 'model_router',
            position: { x: 0, y: 0 },
            policy: 'failover',
        };
        const router2: Node = { ...router, id: 'r2' };

        it('allows Router → Model', () => {
            expect(canConnect([handler, model, router], 'r', 'm').ok).toBe(true);
        });

        it('allows Handler → Router', () => {
            expect(canConnect([handler, model, router], 'h', 'r').ok).toBe(true);
        });

        it('allows ModelRouter → ModelRouter (nesting)', () => {
            expect(canConnect([handler, router, router2], 'r', 'r2').ok).toBe(true);
        });

        it('rejects Model → Router', () => {
            const res = canConnect([handler, model, router], 'm', 'r');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/Model nodes have no outbound connections/);
        });

        it('rejects Router → Handler', () => {
            const res = canConnect([handler, model, router], 'r', 'h');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(
                /Model Router connects out to a Model or another Model Router/,
            );
        });

        it('rejects Tool → ModelRouter (tools wire to Handler)', () => {
            const tool: Node = {
                id: 't',
                type: 'tool',
                position: { x: 0, y: 0 },
                tool_name: 'read',
            };
            const res = canConnect([handler, model, router, tool], 't', 'r');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/Tool must connect/);
        });
    });

    describe('with Tool Pack nodes', () => {
        const pack: Node = {
            id: 'p',
            type: 'tool_pack',
            position: { x: 0, y: 0 },
            pack_name: 'basic-io',
        };

        it('allows Tool Pack → Model in a bare-Model graph', () => {
            expect(canConnect([model, pack], 'p', 'm').ok).toBe(true);
        });

        it('rejects Tool Pack → non-Model in a bare-Model graph', () => {
            const res = canConnect([gateway, pack], 'p', 'g');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(
                /Tool Pack must connect to a Handler, Model, or Permission gate/,
            );
        });

        it('rejects Model → Tool Pack — Model has no outbound on L1', () => {
            const res = canConnect([model, pack], 'm', 'p');
            expect(res.ok).toBe(false);
            expect(res.reason).toMatch(/Model nodes have no outbound connections/);
        });

        it('allows Tool Pack → Handler and Tool Pack → Model when a handler is on canvas (palette-driven; phase 5.6)', () => {
            const handler: Node = {
                id: 'h',
                type: 'handler',
                position: { x: 0, y: 0 },
            };
            expect(canConnect([model, handler, pack], 'p', 'h').ok).toBe(true);
            expect(canConnect([model, handler, pack], 'p', 'm').ok).toBe(true);
        });
    });
});

describe('DebugProbe attach edges', () => {
    const probe: Node = {
        id: 'probe-1',
        type: 'debug_probe',
        position: { x: 0, y: 0 },
        haltOn: 'both',
        enabled: true,
    };
    const handler: Node = {
        id: 'h',
        type: 'handler',
        position: { x: 0, y: 0 },
    };
    const channel: Node = {
        id: 'c',
        type: 'channel',
        position: { x: 0, y: 0 },
        channel_kind: 'webchat',
    };
    const native: Node = {
        id: 'na',
        type: 'native_agent',
        position: { x: 0, y: 0 },
        l1_graph_id: '',
    };

    it('flags probe → target as decorative across L1, L2, and handler canvases', () => {
        const l1 = canConnect([probe, handler, model], probe.id, handler.id);
        expect(l1.ok).toBe(true);
        expect(l1.decorative).toBe(true);

        const l2 = canConnectL2([probe, channel, native], probe.id, native.id);
        expect(l2.ok).toBe(true);
        expect(l2.decorative).toBe(true);

        const handlerInput: Node = {
            id: 'hi',
            type: 'handler_input',
            position: { x: 0, y: 0 },
        };
        const inHandler = canConnectHandler([probe, handlerInput], probe.id, handlerInput.id);
        expect(inHandler.ok).toBe(true);
        expect(inHandler.decorative).toBe(true);
    });

    it('rejects a second probe attached to the same target', () => {
        const probe2: Node = { ...probe, id: 'probe-2' };
        const probe1Bound: Node = { ...probe, attachedTo: native.id };
        const res = probeAttachCheck([probe1Bound, probe2, native], probe2.id, native.id);
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/already attached/);
    });

    it('rejects probe → probe', () => {
        const probe2: Node = { ...probe, id: 'probe-2' };
        const res = probeAttachCheck([probe, probe2], probe.id, probe2.id);
        expect(res.ok).toBe(false);
    });

    it('rejects inbound to a probe (probes are tap nodes, not sinks)', () => {
        expect(canConnectL2([probe, native], native.id, probe.id).ok).toBe(false);
        expect(canConnect([probe, model, gateway], gateway.id, probe.id).ok).toBe(false);
    });

    it('rejects self-loop', () => {
        expect(probeAttachCheck([probe], probe.id, probe.id).ok).toBe(false);
    });
});
