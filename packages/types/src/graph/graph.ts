import type { Edge } from './base.js';
import type { GraphKind } from './base.js';
import type { Node } from './unions.js';

export interface Graph {
    id?: string;
    kind: GraphKind;
    name?: string;
    description?: string;
    nodes: Node[];
    edges: Edge[];
    created_at?: string;
    updated_at?: string;
    library?: boolean;
    system?: boolean;
    fragment?: boolean;
    stopped?: boolean;
}
