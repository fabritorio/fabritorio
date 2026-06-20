import type { Graph } from '@fabritorio/types';
import type { CheckpointBinding } from '../checkpoint.js';
import type { ModelClient } from '../model.js';
import type { PermissionGateHandle } from '../permission.js';
import type { SecretsStore } from '../secrets-store.js';
import type { Tool } from '../tools.js';
import { createGraphHandler } from './graph-handler.js';
import type { Handler } from './handler.js';

export interface HandlerFactoryInput {
    model: ModelClient;
    modelId: string;
    modelNodeId: string;
    handlerNodeId: string;
    systemPrompt: string | (() => string);
    tools: Tool[];
    toolNodeIds: Map<string, string>;
    config: HandlerConfig;
    handlerGraph: Graph;
    permissionByToolName?: Map<string, PermissionGateHandle>;
    checkpoints?: CheckpointBinding[];
    secretsStore?: SecretsStore;
}

export interface HandlerConfig {
    max_iterations?: number;
    temperature?: number;
    max_tokens?: number;
    reasoning?: boolean;
}

export interface HandlerRegistry {
    build(input: HandlerFactoryInput): Handler;
}

function buildGraphHandler(graph: Graph, input: HandlerFactoryInput): Handler {
    return createGraphHandler({
        graph,
        model: input.model,
        modelId: input.modelId,
        modelNodeId: input.modelNodeId,
        handlerNodeId: input.handlerNodeId,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        toolNodeIds: input.toolNodeIds,
        ...(input.permissionByToolName ? { permissionByToolName: input.permissionByToolName } : {}),
        ...(input.checkpoints && input.checkpoints.length > 0
            ? { checkpoints: input.checkpoints }
            : {}),
        ...(input.secretsStore ? { secretsStore: input.secretsStore } : {}),
        ...(input.config.max_iterations !== undefined
            ? { maxIterations: input.config.max_iterations }
            : {}),
        ...(input.config.temperature !== undefined
            ? { temperature: input.config.temperature }
            : {}),
        ...(input.config.max_tokens !== undefined ? { maxTokens: input.config.max_tokens } : {}),
        ...(input.config.reasoning !== undefined ? { reasoning: input.config.reasoning } : {}),
    });
}

export function createDefaultHandlerRegistry(): HandlerRegistry {
    return {
        build(input) {
            return buildGraphHandler(input.handlerGraph, input);
        },
    };
}
