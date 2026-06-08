import type { Node } from '@fabritorio/types';
import type { RunnerClient } from '@/lib/runner-client';

export interface InspectorProps<T extends Node = Node> {
    node: T;
    onChange?: (id: string, patch: Partial<Node>) => void;
    client?: RunnerClient;
    currentGraphId?: string | null;
}
