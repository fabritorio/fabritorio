import type { BaseNode } from './base.js';

export interface SecretBinding {
    name: string;
    source: string;
}

export interface SecretsNode extends BaseNode {
    type: 'secrets';
    bindings: SecretBinding[];
}
