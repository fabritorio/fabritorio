import { describe, expect, it } from 'vitest';
import type { AskCallDetail, AskCallSummary } from '@fabritorio/types';
import type { AgentCallsResult, RunnerClient } from '../lib/runner-client';

function makeSummary(
    eventId: string,
    calleeId: string,
    status: AskCallSummary['status'],
): AskCallSummary {
    return {
        eventId,
        askCallId: `ask-${eventId}`,
        calleeNodeId: calleeId,
        status,
        startedAt: 1000,
        durationMs: status === 'running' ? null : 250,
        briefSnippet: `brief for ${eventId}`,
        resultSnippet: status === 'running' ? null : `result for ${eventId}`,
    };
}

function makeDetail(eventId: string, status: AskCallDetail['response']['status']): AskCallDetail {
    return {
        call: {
            brief: `brief for ${eventId}`,
            askChain: ['caller'],
            inheritSession: false,
            timeoutMs: 60_000,
            calleeNodeId: 'callee',
            callerNodeId: 'caller',
        },
        response: {
            stdout: status === 'running' ? '' : `stdout for ${eventId}`,
            exitCode: status === 'failed' ? 1 : 0,
            status,
            durationMs: status === 'running' ? null : 250,
        },
        internal: [],
    };
}

interface FakeClientCalls {
    agentCalls: Array<{
        graphId: string;
        nodeId: string;
        opts?: { before?: string; limit?: number };
    }>;
    agentCallDetail: Array<{ graphId: string; nodeId: string; eventId: string }>;
}

function fakeClient(opts: {
    callsResult: AgentCallsResult;
    detailFor?: (eventId: string) => AskCallDetail;
}): { client: RunnerClient; recorded: FakeClientCalls } {
    const recorded: FakeClientCalls = { agentCalls: [], agentCallDetail: [] };
    const client = {
        agentCalls: async (
            graphId: string,
            nodeId: string,
            q?: { before?: string; limit?: number },
        ) => {
            recorded.agentCalls.push({ graphId, nodeId, ...(q ? { opts: q } : {}) });
            return opts.callsResult;
        },
        agentCallDetail: async (graphId: string, nodeId: string, eventId: string) => {
            recorded.agentCallDetail.push({ graphId, nodeId, eventId });
            if (!opts.detailFor) throw new Error('no detail stub configured');
            return opts.detailFor(eventId);
        },
    } as unknown as RunnerClient;
    return { client, recorded };
}

describe('AskCallsModal data contract', () => {
    it('agentCalls is called with the configured limit when fetching the first page', async () => {
        const { client, recorded } = fakeClient({
            callsResult: { callerNodeId: 'caller', calls: [] },
        });
        await client.agentCalls('graph-1', 'caller', { limit: 50 });
        expect(recorded.agentCalls).toHaveLength(1);
        expect(recorded.agentCalls[0]!.graphId).toBe('graph-1');
        expect(recorded.agentCalls[0]!.nodeId).toBe('caller');
        expect(recorded.agentCalls[0]!.opts?.limit).toBe(50);
    });

    it('empty list payload is observable to the modal — no rows means EmptyState', async () => {
        const { client } = fakeClient({
            callsResult: { callerNodeId: 'caller', calls: [] },
        });
        const result = await client.agentCalls('g', 'caller');
        expect(result.calls).toEqual([]);
    });

    it('single-row payload exposes the call fields the row consumes', async () => {
        const summary = makeSummary('e1', 'callee-x', 'ok');
        const { client } = fakeClient({
            callsResult: { callerNodeId: 'caller', calls: [summary] },
        });
        const result = await client.agentCalls('g', 'caller');
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]!.calleeNodeId).toBe('callee-x');
        expect(result.calls[0]!.status).toBe('ok');
        expect(result.calls[0]!.durationMs).toBe(250);
    });

    it('row selection triggers agentCallDetail with the row eventId', async () => {
        const summary = makeSummary('e1', 'callee', 'ok');
        const detail = makeDetail('e1', 'ok');
        const { client, recorded } = fakeClient({
            callsResult: { callerNodeId: 'caller', calls: [summary] },
            detailFor: () => detail,
        });
        const got = await client.agentCallDetail('g', 'caller', summary.eventId);
        expect(recorded.agentCallDetail[0]).toEqual({
            graphId: 'g',
            nodeId: 'caller',
            eventId: 'e1',
        });
        expect(got.response.status).toBe('ok');
        expect(got.response.stdout).toBe('stdout for e1');
    });

    it('mid-flight call surfaces null durationMs and running status', async () => {
        const summary = makeSummary('e1', 'callee', 'running');
        const { client } = fakeClient({
            callsResult: { callerNodeId: 'caller', calls: [summary] },
        });
        const result = await client.agentCalls('g', 'caller');
        expect(result.calls[0]!.durationMs).toBeNull();
        expect(result.calls[0]!.resultSnippet).toBeNull();
        expect(result.calls[0]!.status).toBe('running');
    });

    it('paging with `before` propagates the ISO timestamp', async () => {
        const { client, recorded } = fakeClient({
            callsResult: { callerNodeId: 'caller', calls: [] },
        });
        await client.agentCalls('g', 'caller', { before: '2024-01-02T00:00:00.000Z', limit: 10 });
        expect(recorded.agentCalls[0]!.opts?.before).toBe('2024-01-02T00:00:00.000Z');
    });
});
