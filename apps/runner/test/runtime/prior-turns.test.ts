import { describe, it, expect } from 'vitest';
import type { DispatchEvent, OutputEmittedEvent } from '@fabritorio/types';
import {
    createPriorTurnsTool,
    type BuiltinToolBuildCtx,
    type BuiltinToolDispatchContext,
    type PriorTurnEntry,
} from '../../src/runtime/builtin-tools.js';
import { createEventBus, type EventBus } from '../../src/runtime/event-bus.js';
import { newDispatch } from '../../src/runtime/dispatch.js';

const TOOL_CTX = { call_id: 'c1', eventId: 'ev-current' };

interface SeedTurnArgs {
    label: string;
    source: string;
    userContent: string;
    reply?: { content: string; port?: 'result' | 'error' };
    userTimestamp?: number;
    replyTs?: string;
}

interface SeededTurn {
    root: DispatchEvent;
    output?: OutputEmittedEvent;
}

function seedTurn(bus: EventBus, args: SeedTurnArgs): SeededTurn {
    const root = newDispatch({
        source: args.source,
        messages: [{ role: 'user', content: args.userContent }],
        ...(args.userTimestamp !== undefined ? { now: () => args.userTimestamp! } : {}),
    });
    bus.emitDispatch(root);
    if (!args.reply) return { root };
    const replyTs =
        args.replyTs ??
        (args.userTimestamp !== undefined
            ? new Date(args.userTimestamp + 50).toISOString()
            : new Date().toISOString());
    const output: OutputEmittedEvent = {
        type: 'output.emitted',
        ts: replyTs,
        eventId: root.eventId,
        parentId: root.eventId,
        node_id: 'output-1',
        port: args.reply.port ?? 'result',
        port_id: args.reply.port ?? 'result',
        messages: [{ role: 'assistant', content: args.reply.content }],
    };
    bus.emitObservability(output);
    return { root, output };
}

function makeBuildCtx(bus: EventBus, currentDispatch: DispatchEvent): BuiltinToolBuildCtx {
    return {
        bus,
        callerNodeId: 'agent-A',
        currentContext(): BuiltinToolDispatchContext | null {
            return {
                currentDispatch,
                outgoing: [],
                topicFor: (e) => e.id,
            };
        },
    };
}

async function callPriorTurns(
    bus: EventBus,
    currentDispatch: DispatchEvent,
    args: Record<string, unknown> = {},
): Promise<{ exitCode: number; entries: PriorTurnEntry[]; stderr: string }> {
    const tool = createPriorTurnsTool(makeBuildCtx(bus, currentDispatch));
    const result = await tool.handler(args, TOOL_CTX);
    return {
        exitCode: result.exit_code,
        entries: result.exit_code === 0 ? (JSON.parse(result.stdout) as PriorTurnEntry[]) : [],
        stderr: result.stderr,
    };
}

describe('prior_turns', () => {
    it('returns [] for an empty session (no prior roots indexed)', async () => {
        const bus = createEventBus();
        const current = newDispatch({
            source: 'channel:fresh',
            messages: [{ role: 'user', content: 'first turn' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries).toEqual([]);
    });

    it('one prior turn (root + reply) → returns 2 entries, user then assistant', async () => {
        const bus = createEventBus();
        const SOURCE = 'channel:c1';
        const prior = seedTurn(bus, {
            label: 't1',
            source: SOURCE,
            userContent: 'hello',
            reply: { content: 'hi back' },
            userTimestamp: 1000,
            replyTs: new Date(1100).toISOString(),
        });
        const current = newDispatch({
            source: SOURCE,
            messages: [{ role: 'user', content: 'second turn' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries).toEqual([
            {
                eventId: prior.root.eventId,
                timestamp: 1000,
                role: 'user',
                content: 'hello',
            },
            {
                eventId: prior.root.eventId,
                timestamp: 1100,
                role: 'assistant',
                content: 'hi back',
            },
        ]);
    });

    it('two prior turns → 4 entries, oldest first', async () => {
        const bus = createEventBus();
        const SOURCE = 'channel:c1';
        const t1 = seedTurn(bus, {
            label: 't1',
            source: SOURCE,
            userContent: 'q1',
            reply: { content: 'a1' },
            userTimestamp: 1000,
            replyTs: new Date(1100).toISOString(),
        });
        const t2 = seedTurn(bus, {
            label: 't2',
            source: SOURCE,
            userContent: 'q2',
            reply: { content: 'a2' },
            userTimestamp: 2000,
            replyTs: new Date(2100).toISOString(),
        });
        const current = newDispatch({
            source: SOURCE,
            messages: [{ role: 'user', content: 'q3' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries.map((e) => `${e.role}:${e.content}`)).toEqual([
            'user:q1',
            'assistant:a1',
            'user:q2',
            'assistant:a2',
        ]);
        expect(r.entries[0]!.eventId).toBe(t1.root.eventId);
        expect(r.entries[3]!.eventId).toBe(t2.root.eventId);
    });

    it('limit: 1 with three prior turns → returns most recent turn only', async () => {
        const bus = createEventBus();
        const SOURCE = 'channel:c1';
        seedTurn(bus, {
            label: 't1',
            source: SOURCE,
            userContent: 'q1',
            reply: { content: 'a1' },
            userTimestamp: 1000,
        });
        seedTurn(bus, {
            label: 't2',
            source: SOURCE,
            userContent: 'q2',
            reply: { content: 'a2' },
            userTimestamp: 2000,
        });
        const t3 = seedTurn(bus, {
            label: 't3',
            source: SOURCE,
            userContent: 'q3',
            reply: { content: 'a3' },
            userTimestamp: 3000,
        });
        const current = newDispatch({
            source: SOURCE,
            messages: [{ role: 'user', content: 'q4' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current, { limit: 1 });
        expect(r.exitCode).toBe(0);
        expect(r.entries).toHaveLength(2);
        expect(r.entries[0]!.eventId).toBe(t3.root.eventId);
        expect(r.entries[0]!.role).toBe('user');
        expect(r.entries[0]!.content).toBe('q3');
        expect(r.entries[1]!.role).toBe('assistant');
        expect(r.entries[1]!.content).toBe('a3');
    });

    it('mid-flight prior root with no reply → only user entry for that turn', async () => {
        const bus = createEventBus();
        const SOURCE = 'channel:c1';
        const t1 = seedTurn(bus, {
            label: 't1',
            source: SOURCE,
            userContent: 'completed q',
            reply: { content: 'completed a' },
            userTimestamp: 1000,
            replyTs: new Date(1100).toISOString(),
        });
        const t2 = seedTurn(bus, {
            label: 't2',
            source: SOURCE,
            userContent: 'mid-flight q',
            userTimestamp: 2000,
        });
        const current = newDispatch({
            source: SOURCE,
            messages: [{ role: 'user', content: 'next' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries).toHaveLength(3);
        expect(r.entries[0]!.eventId).toBe(t1.root.eventId);
        expect(r.entries[0]!.role).toBe('user');
        expect(r.entries[1]!.eventId).toBe(t1.root.eventId);
        expect(r.entries[1]!.role).toBe('assistant');
        expect(r.entries[2]).toEqual({
            eventId: t2.root.eventId,
            timestamp: 2000,
            role: 'user',
            content: 'mid-flight q',
        });
    });

    it('errored prior turn → assistant entry preserved with error content', async () => {
        const bus = createEventBus();
        const SOURCE = 'channel:c1';
        const errored = seedTurn(bus, {
            label: 't1',
            source: SOURCE,
            userContent: 'will fail',
            reply: { content: '[error] tool blew up', port: 'error' },
            userTimestamp: 1000,
            replyTs: new Date(1100).toISOString(),
        });
        const current = newDispatch({
            source: SOURCE,
            messages: [{ role: 'user', content: 'next' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries).toHaveLength(2);
        expect(r.entries[1]).toEqual({
            eventId: errored.root.eventId,
            timestamp: 1100,
            role: 'assistant',
            content: '[error] tool blew up',
        });
    });

    it('refuses cleanly when no in-flight Dispatch context is available', async () => {
        const bus = createEventBus();
        const buildCtx: BuiltinToolBuildCtx = {
            bus,
            callerNodeId: 'agent-A',
            currentContext: () => null,
        };
        const tool = createPriorTurnsTool(buildCtx);
        const r = await tool.handler({}, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/in-flight Dispatch context/);
    });

    it('refuses cleanly when no buildCtx is wired (DebugGateway / unwired path)', async () => {
        const tool = createPriorTurnsTool(null);
        const r = await tool.handler({}, TOOL_CTX);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/in-flight Dispatch context/);
    });

    it('excludes the in-flight turn (current Dispatch eventId) from the result', async () => {
        const bus = createEventBus();
        const SOURCE = 'channel:c1';
        const prior = seedTurn(bus, {
            label: 't1',
            source: SOURCE,
            userContent: 'old',
            reply: { content: 'old-a' },
            userTimestamp: 1000,
        });
        const current = newDispatch({
            source: SOURCE,
            messages: [{ role: 'user', content: 'in-flight q' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries).toHaveLength(2);
        expect(r.entries[0]!.eventId).toBe(prior.root.eventId);
        expect(r.entries[1]!.eventId).toBe(prior.root.eventId);
        for (const entry of r.entries) {
            expect(entry.eventId).not.toBe(current.eventId);
        }
    });

    it('empty source → returns []', async () => {
        const bus = createEventBus();
        const current = newDispatch({
            source: '',
            messages: [{ role: 'user', content: 'orphan' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries).toEqual([]);
    });

    it('default limit caps at 10 turns', async () => {
        const bus = createEventBus();
        const SOURCE = 'channel:c1';
        for (let i = 0; i < 12; i++) {
            seedTurn(bus, {
                label: `t${i}`,
                source: SOURCE,
                userContent: `q${i}`,
                reply: { content: `a${i}` },
                userTimestamp: 1000 + i * 100,
            });
        }
        const current = newDispatch({
            source: SOURCE,
            messages: [{ role: 'user', content: 'now' }],
        });
        bus.emitDispatch(current);

        const r = await callPriorTurns(bus, current);
        expect(r.exitCode).toBe(0);
        expect(r.entries).toHaveLength(20);
        expect(r.entries[0]!.content).toBe('q2');
        expect(r.entries[19]!.content).toBe('a11');
    });
});
