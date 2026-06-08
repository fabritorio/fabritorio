import type { NodeExecState } from './node-state';
import { kindColorClasses, type Kind } from './node-color';

export type { Kind };

export function nodeStateClassName(kind: Kind, state: NodeExecState): string {
    const base = kindColorClasses(kind, 'node');

    switch (state) {
        case 'idle':
            return `fab-node ${base} fab-state-idle`;
        case 'running':
            return `fab-node ${base} fab-state-running`;
        case 'waiting':
            return `fab-node ${base} fab-state-waiting`;
        case 'completed':
            return `fab-node ${base} fab-state-completed`;
        case 'error':
            return `fab-node ${base} fab-state-error border-rose-400 bg-rose-50 dark:border-rose-500/60 dark:bg-rose-500/10`;
    }
}
