export interface Position {
    x: number;
    y: number;
}

export interface BaseNode {
    id: string;
    position: Position;
    instantiated_from?: string;
}

export interface EdgeEndpoint {
    node_id: string;
    port_id?: string;
}

export interface Edge {
    id: string;
    source: EdgeEndpoint;
    target: EdgeEndpoint;
    topic?: string;
    priority?: number;
}

export type GraphKind = 'toolpack' | 'skillpack' | 'handler' | 'l1' | 'l2';
