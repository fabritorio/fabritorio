import type { NodeType } from './graph/unions.js';
import type { GraphKind } from './graph/base.js';

export type PortKind = 'reference' | 'event';

export type PortDirection = 'in' | 'out';

export interface PortDef {
    id: string;
    kind: PortKind;
    direction: PortDirection;
}

export interface PaletteNodeSpec {
    inPorts: PortDef[];
    outPorts: PortDef[];
    requiredFields: string[];
    defaultedFields: string[];
}

export interface ConnectionRule {
    source: NodeType;
    target: NodeType;
    sourcePort?: string;
    targetPort?: string;
    decorative?: boolean;
    errorMessage?: string;
}

export interface CompositeKindSpec {
    allowedNodeTypes: NodeType[];
    decorativeEdges?: boolean;
    topology?: {
        singleGateway?: boolean;
        requireOutput?: boolean;
    };
}

export interface Palette {
    version: number;
    nodes: Partial<Record<NodeType, PaletteNodeSpec>>;
    connections: Partial<Record<GraphKind, ConnectionRule[]>>;
    compositeKinds: Partial<Record<GraphKind, CompositeKindSpec>>;
}
