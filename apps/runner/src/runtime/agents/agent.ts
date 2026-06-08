import type { DispatchEvent, Message, ObservabilityEvent } from '@fabritorio/types';

export interface Agent {
    readonly outputNodeId: string;

    dispatch(inbound: DispatchEvent, ctx: AgentDispatchCtx): Promise<AgentReply>;
}

export interface AgentDispatchCtx {
    emitObservability: (event: ObservabilityEvent) => void;
}

export interface AgentReply {
    output: Message;
    errored: boolean;
    stopped?: boolean;
}
