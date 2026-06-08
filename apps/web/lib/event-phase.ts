import type { ObservabilityEvent } from '@fabritorio/types';

export function phaseOf(event: ObservabilityEvent): string | null {
    switch (event.type) {
        case 'llm.chunk':
            return event.kind === 'reasoning' ? 'thinking…' : 'responding…';
        case 'llm.request':
            return 'responding…';
        case 'tool.called': {
            if (event.tool_name === 'ask_agent') {
                const callee = askCalleeOf(event.args);
                return callee ? `asking ${callee}` : 'asking agent';
            }
            return `running ${event.tool_name}`;
        }
        case 'model_router.fell_through':
            return 'retrying model';
        case 'output.emitted':
        case 'llm.response':
            return null;
        default:
            return null;
    }
}

function askCalleeOf(args: Record<string, unknown>): string | null {
    const target = args['target_agent_id'];
    return typeof target === 'string' && target.length > 0 ? target : null;
}
