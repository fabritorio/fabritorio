import type { BaseNode } from './base.js';

export interface HandlerInputNode extends BaseNode {
    type: 'handler_input';
}

export interface HandlerOutputNode extends BaseNode {
    type: 'handler_output';
    ports?: string[];
}

export interface PromptBuilderNode extends BaseNode {
    type: 'prompt_builder';
}

export interface ModelCallNode extends BaseNode {
    type: 'model_call';
}

export interface ToolExecNode extends BaseNode {
    type: 'tool_exec';
}

export interface EvaluatorNode extends BaseNode {
    type: 'evaluator';
    ports?: string[];
}
