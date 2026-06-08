import type { BaseNode } from './base.js';

export interface DebugGatewayNode extends BaseNode {
    type: 'debug_gateway';
    mode?: 'live' | 'scratch';
    display_name?: string;
}

export interface DebugProbeNode extends BaseNode {
    type: 'debug_probe';
    attachedTo?: string;
    haltOn?: 'pre' | 'post' | 'both';
    enabled?: boolean;
    display_name?: string;
}
