import type { Message, ObservabilityEvent } from '@fabritorio/types';

export interface Handler {
    run(inbound: Message[], ctx: HandlerCtx): Promise<HandlerResult>;
}

export interface HandlerCtx {
    eventId: string;
    emitObservability?: (event: ObservabilityEvent) => void;
    signal?: AbortSignal;
}

export interface HandlerResult {
    output: Message;
    errored: boolean;
    stopped?: boolean;
}
