import type { BaseNode } from './base.js';

export interface CliInvocationTargetNode extends BaseNode {
    type: 'cli_invocation_target';
    display_name?: string;
}
