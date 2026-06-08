import { describe, expect, it } from 'vitest';
import type {
    ChannelNode,
    DispatchEvent,
    Graph,
    NativeAgentNode,
    ObservabilityEvent,
} from '@fabritorio/types';
import {
    buildChatTurns,
    chatSource,
    hideSystemChannels,
    isSystemChannel,
    isUserChannel,
    isUserRootEcho,
    sidecarChannelIdFor,
    type AssistantTurn,
    type ChatTurn,
} from '../lib/webchat';

function expectAssistant(turn: ChatTurn | undefined): AssistantTurn {
    if (!turn || turn.kind !== 'assistant') {
        throw new Error('expected an assistant turn');
    }
    return turn;
}

const makeChannel = (id: string, ownerNodeId?: string): ChannelNode => ({
    id,
    type: 'channel',
    position: { x: 0, y: 0 },
    channel_kind: 'webchat',
    ...(ownerNodeId ? { owner_node_id: ownerNodeId } : {}),
});

const makeAgent = (id: string): NativeAgentNode => ({
    id,
    type: 'native_agent',
    position: { x: 0, y: 0 },
    l1_graph_id: 'l1-x',
});

describe('isSystemChannel / isUserChannel', () => {
    it('classifies an owner-bearing channel as system, owner-less as user', () => {
        const sidecar = makeChannel('chan-sys', 'agent-1');
        const userPlaced = makeChannel('chan-user');
        expect(isSystemChannel(sidecar)).toBe(true);
        expect(isUserChannel(sidecar)).toBe(false);
        expect(isSystemChannel(userPlaced)).toBe(false);
        expect(isUserChannel(userPlaced)).toBe(true);
    });

    it('treats an empty-string owner_node_id as user-placed (not system)', () => {
        const node = { ...makeChannel('chan-x'), owner_node_id: '' } as ChannelNode;
        expect(isSystemChannel(node)).toBe(false);
        expect(isUserChannel(node)).toBe(true);
    });

    it('returns false for non-channel nodes', () => {
        const agent = makeAgent('agent-1');
        expect(isSystemChannel(agent)).toBe(false);
        expect(isUserChannel(agent)).toBe(false);
    });
});

describe('hideSystemChannels (canvas mapping filter, F1/F2)', () => {
    it('omits system channels and every edge touching them, keeping user channels + normal edges', () => {
        const nodes = [
            makeAgent('agent-1'),
            makeChannel('sidecar-1', 'agent-1'), // system — hidden
            makeChannel('user-chan'), // user-placed — kept
        ];
        const edges = [
            {
                id: 'sidecar-1->agent-1',
                source: { node_id: 'sidecar-1' },
                target: { node_id: 'agent-1' },
            },
            {
                id: 'agent-1->sidecar-1',
                source: { node_id: 'agent-1' },
                target: { node_id: 'sidecar-1' },
            },
            {
                id: 'user-chan->agent-1',
                source: { node_id: 'user-chan' },
                target: { node_id: 'agent-1' },
            },
        ];
        const out = hideSystemChannels(nodes, edges);
        expect(out.nodes.map((n) => n.id).sort()).toEqual(['agent-1', 'user-chan']);
        expect(out.edges.map((e) => e.id)).toEqual(['user-chan->agent-1']);
    });

    it('is a no-op when there are no system channels', () => {
        const nodes = [makeAgent('agent-1'), makeChannel('user-chan')];
        const edges = [
            {
                id: 'user-chan->agent-1',
                source: { node_id: 'user-chan' },
                target: { node_id: 'agent-1' },
            },
        ];
        const out = hideSystemChannels(nodes, edges);
        expect(out.nodes).toHaveLength(2);
        expect(out.edges).toHaveLength(1);
    });
});

describe('sidecarChannelIdFor', () => {
    it('resolves the sidecar channel owned by an agent', () => {
        const graph: Graph = {
            kind: 'l2',
            nodes: [makeAgent('agent-1'), makeChannel('chan-sys', 'agent-1'), makeChannel('other')],
            edges: [],
        };
        expect(sidecarChannelIdFor(graph, 'agent-1')).toBe('chan-sys');
    });

    it('returns null when the agent has no sidecar yet', () => {
        const graph: Graph = {
            kind: 'l2',
            nodes: [makeAgent('agent-1')],
            edges: [],
        };
        expect(sidecarChannelIdFor(graph, 'agent-1')).toBeNull();
    });
});

describe('isUserRootEcho', () => {
    it('is true for the user own root echo (no parentId, first message role user)', () => {
        const ev: DispatchEvent = {
            eventId: 'root-1',
            source: SOURCE,
            timestamp: 1_000,
            messages: [{ role: 'user', content: 'hi' }],
        };
        expect(isUserRootEcho(ev)).toBe(true);
    });

    it('is false for an agent reply (parentId set, assistant role) — flows to liveReplies', () => {
        const reply: DispatchEvent = {
            eventId: 'root-1-reply',
            parentId: 'root-1',
            source: SOURCE,
            timestamp: 1_500,
            messages: [{ role: 'assistant', content: 'pong' }],
            meta: { port: 'result' },
        };
        expect(isUserRootEcho(reply)).toBe(false);
    });

    it('is false for a root whose first message is not a user turn', () => {
        const ev: DispatchEvent = {
            eventId: 'root-x',
            source: SOURCE,
            timestamp: 1_000,
            messages: [{ role: 'assistant', content: 'system-ish' }],
        };
        expect(isUserRootEcho(ev)).toBe(false);
    });
});

const SOURCE = 'webchat:chan-1';

const userDispatch = (root: string, ts: number, content: string): DispatchEvent => ({
    eventId: root,
    source: SOURCE,
    timestamp: ts,
    messages: [{ role: 'user', content }],
});

const replyDispatch = (
    root: string,
    ts: number,
    content: string,
    port: 'result' | 'error' = 'result',
    source: string = SOURCE,
): DispatchEvent => ({
    eventId: `${root}-reply`,
    parentId: root,
    source,
    timestamp: ts,
    messages: [{ role: 'assistant', content }],
    meta: { port },
});

const obs = (
    ev: Partial<ObservabilityEvent> & { type: ObservabilityEvent['type'] },
): ObservabilityEvent =>
    ({
        ts: '2026-04-29T00:00:00.000Z',
        eventId: 'root',
        node_id: 'n',
        ...ev,
    }) as ObservabilityEvent;

describe('buildChatTurns', () => {
    it('builds a single user → assistant turn from a recorded dispatch tree', () => {
        const turns = buildChatTurns(
            {
                events: [
                    userDispatch('root-1', 1_000, 'hi'),
                    obs({
                        type: 'tool.called',
                        ts: '2026-04-29T00:00:01.000Z',
                        eventId: 'root-1',
                        node_id: 'tool-1',
                        tool_name: 'read_file',
                        args: { path: 'notes.md' },
                        call_id: 'c1',
                    }),
                    obs({
                        type: 'tool.result',
                        ts: '2026-04-29T00:00:02.000Z',
                        eventId: 'root-1',
                        node_id: 'tool-1',
                        call_id: 'c1',
                        stdout: 'hello world',
                        stderr: '',
                        exit_code: 0,
                    }),
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:03.000Z',
                        eventId: 'root-1',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'the file says hello world' }],
                    }),
                ],
            },
            SOURCE,
        );
        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({
            kind: 'user',
            content: 'hi',
            rootEventId: 'root-1',
        });
        const assistant = expectAssistant(turns[1]);
        expect(assistant.content).toBe('the file says hello world');
        expect(assistant.errored).toBe(false);
        expect(assistant.toolCalls).toHaveLength(1);
        expect(assistant.toolCalls[0]).toMatchObject({
            name: 'read_file',
            args: { path: 'notes.md' },
            result: { stdout: 'hello world', exit_code: 0 },
        });
    });

    it('merges multiple turns ordered by timestamp', () => {
        const t = (n: number) => Date.parse(`2026-04-29T00:00:0${n}.000Z`);
        const turns = buildChatTurns(
            {
                events: [
                    userDispatch('root-2', t(5), 'second'),
                    userDispatch('root-1', t(1), 'first'),
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:02.000Z',
                        eventId: 'root-1',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'reply 1' }],
                    }),
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:06.000Z',
                        eventId: 'root-2',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'reply 2' }],
                    }),
                ],
            },
            SOURCE,
        );
        expect(turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(expectAssistant(turns[1]).content).toBe('reply 1');
        expect(expectAssistant(turns[3]).content).toBe('reply 2');
    });

    it('flags error-port replies', () => {
        const turns = buildChatTurns(
            {
                events: [
                    userDispatch('root-1', 1_000, 'go'),
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:01.000Z',
                        eventId: 'root-1',
                        node_id: 'output-1',
                        port_id: 'error',
                        port: 'error',
                        messages: [{ role: 'assistant', content: '[error] tool exploded' }],
                    }),
                ],
            },
            SOURCE,
        );
        const assistant = expectAssistant(turns[1]);
        expect(assistant.errored).toBe(true);
        expect(assistant.content).toBe('[error] tool exploded');
    });

    it('marks a turn stopped (neutral) when its root is in stoppedEventIds, without erroring it', () => {
        const turns = buildChatTurns(
            {
                events: [
                    userDispatch('root-1', 1_000, 'go'),
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:01.000Z',
                        eventId: 'root-1',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'partial work so f' }],
                    }),
                ],
            },
            SOURCE,
            [],
            new Set(['root-1']),
        );
        const assistant = expectAssistant(turns[1]);
        expect(assistant.stopped).toBe(true);
        expect(assistant.errored).toBe(false);
        expect(assistant.content).toBe('partial work so f');
    });

    it('defaults stopped to false when the root is not in stoppedEventIds', () => {
        const turns = buildChatTurns({ events: [userDispatch('root-1', 1_000, 'ping')] }, SOURCE, [
            replyDispatch('root-1', 1_500, 'pong'),
        ]);
        const assistant = expectAssistant(turns[1]);
        expect(assistant.stopped).toBe(false);
    });

    it('marks a live-reply turn stopped when its root was stopped before output.emitted lands', () => {
        const turns = buildChatTurns(
            { events: [userDispatch('root-1', 1_000, 'ping')] },
            SOURCE,
            [replyDispatch('root-1', 1_500, 'partial')],
            new Set(['root-1']),
        );
        const assistant = expectAssistant(turns[1]);
        expect(assistant.stopped).toBe(true);
        expect(assistant.errored).toBe(false);
        expect(assistant.content).toBe('partial');
    });

    it('marks a turn stopped from a REPLAYED reply event carrying meta.stopped (reload / cross-client)', () => {
        const stoppedReply: DispatchEvent = {
            eventId: 'root-1-reply',
            parentId: 'root-1',
            source: SOURCE,
            timestamp: 1_500,
            messages: [{ role: 'assistant', content: 'partial work' }],
            meta: { port: 'result', stopped: true },
        };
        const turns = buildChatTurns(
            { events: [userDispatch('root-1', 1_000, 'go'), stoppedReply] },
            SOURCE,
            [],
            new Set(), // empty optimistic set — the durable flag must stand alone
        );
        const assistant = expectAssistant(turns[1]);
        expect(assistant.stopped).toBe(true);
        expect(assistant.errored).toBe(false);
    });

    it('marks a live-reply turn stopped from meta.stopped even with an empty optimistic set', () => {
        const stoppedReply: DispatchEvent = {
            eventId: 'root-1-reply',
            parentId: 'root-1',
            source: SOURCE,
            timestamp: 1_500,
            messages: [{ role: 'assistant', content: 'partial' }],
            meta: { port: 'result', stopped: true },
        };
        const turns = buildChatTurns(
            { events: [userDispatch('root-1', 1_000, 'ping')] },
            SOURCE,
            [stoppedReply],
            new Set(),
        );
        const assistant = expectAssistant(turns[1]);
        expect(assistant.stopped).toBe(true);
        expect(assistant.errored).toBe(false);
    });

    it('uses live SSE replies as fallback assistant content before output.emitted lands', () => {
        const turns = buildChatTurns(
            {
                events: [userDispatch('root-1', 1_000, 'ping')],
            },
            SOURCE,
            [replyDispatch('root-1', 1_500, 'pong')],
        );
        expect(turns).toHaveLength(2);
        const assistant = expectAssistant(turns[1]);
        expect(assistant.content).toBe('pong');
    });

    it('ignores dispatches from a different source', () => {
        const turns = buildChatTurns(
            {
                events: [
                    {
                        eventId: 'other',
                        source: 'webchat:other-channel',
                        timestamp: 1_000,
                        messages: [{ role: 'user', content: 'not me' }],
                    },
                ],
            },
            SOURCE,
        );
        expect(turns).toEqual([]);
    });

    it('sets rootSource to the channel source for user-typed turns', () => {
        const turns = buildChatTurns(
            {
                events: [
                    userDispatch('root-1', 1_000, 'hi'),
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:01.000Z',
                        eventId: 'root-1',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'hello' }],
                    }),
                ],
            },
            SOURCE,
        );
        const assistant = expectAssistant(turns[1]);
        expect(assistant.rootSource).toBe(SOURCE);
    });

    it('drops a trigger-rooted live reply (firehose scope, F4)', () => {
        const triggerSource = 'trigger:sched-1';
        const reply: DispatchEvent = {
            eventId: 'root-1-reply',
            parentId: 'root-1',
            source: triggerSource,
            timestamp: 1_500,
            messages: [{ role: 'assistant', content: 'tick' }],
            meta: { port: 'result' },
        };
        const turns = buildChatTurns({ events: [] }, SOURCE, [reply]);
        expect(turns).toEqual([]);
    });

    it('scopes to the active conversation amid firehose noise (F4 regression guard)', () => {
        const activeSource = chatSource('agent-1', 'conv-A');
        const otherConvSource = chatSource('agent-1', 'conv-B');
        const triggerSource = 'trigger:sched-1';
        const turns = buildChatTurns(
            {
                events: [
                    {
                        eventId: 'root-A',
                        source: activeSource,
                        timestamp: 1_000,
                        messages: [{ role: 'user', content: 'hello A' }],
                    },
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:01.000Z',
                        eventId: 'root-A',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'reply A' }],
                    }),
                    {
                        eventId: 'root-B',
                        source: otherConvSource,
                        timestamp: 2_000,
                        messages: [{ role: 'user', content: 'hello B' }],
                    },
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:02.000Z',
                        eventId: 'root-B',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'reply B' }],
                    }),
                    {
                        eventId: 'root-T',
                        source: triggerSource,
                        timestamp: 3_000,
                        messages: [{ role: 'user', content: 'cron tick' }],
                    },
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:03.000Z',
                        eventId: 'root-T',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'trigger reply' }],
                    }),
                ],
            },
            activeSource,
        );
        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({ kind: 'user', content: 'hello A' });
        expect(expectAssistant(turns[1]).content).toBe('reply A');
        const allContent = turns.map((t) => t.content).join('|');
        expect(allContent).not.toContain('reply B');
        expect(allContent).not.toContain('trigger reply');
        expect(allContent).not.toContain('hello B');
    });

    it('captures reasoning from llm.response when present', () => {
        const turns = buildChatTurns(
            {
                events: [
                    userDispatch('root-1', 1_000, 'hi'),
                    obs({
                        type: 'llm.response',
                        ts: '2026-04-29T00:00:01.000Z',
                        eventId: 'root-1',
                        node_id: 'model-1',
                        content: 'out',
                        reasoning: 'thinking step',
                        finish_reason: 'stop',
                    }),
                    obs({
                        type: 'output.emitted',
                        ts: '2026-04-29T00:00:02.000Z',
                        eventId: 'root-1',
                        node_id: 'output-1',
                        port_id: 'result',
                        port: 'result',
                        messages: [{ role: 'assistant', content: 'out' }],
                    }),
                ],
            },
            SOURCE,
        );
        const assistant = expectAssistant(turns[1]);
        expect(assistant.reasoning).toBe('thinking step');
    });
});
