import type { Graph } from '@fabritorio/types';
import type { CheckpointBinding } from '../checkpoint.js';
import type { ModelClient } from '../model.js';
import type { PermissionGateHandle } from '../permission.js';
import type { SecretsStore } from '../secrets-store.js';
import type { Tool } from '../tools.js';
import { createGraphHandler } from './graph-handler.js';
import type { Handler } from './handler.js';
import { createSimpleHandler } from './simple.js';

export interface HandlerFactoryInput {
    model: ModelClient;
    modelId: string;
    modelNodeId: string;
    handlerNodeId: string;
    systemPrompt: string | (() => string);
    tools: Tool[];
    toolNodeIds: Map<string, string>;
    config: HandlerConfig;
    handlerGraph?: Graph | null;
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

export type HandlerFactory = (input: HandlerFactoryInput) => Handler;

export interface HandlerRegistry {
    build(name: string, input: HandlerFactoryInput): Handler;
    register(name: string, factory: HandlerFactory): void;
}

function buildSimpleHandler(input: HandlerFactoryInput): Handler {
    return createSimpleHandler({
        model: input.model,
        modelId: input.modelId,
        modelNodeId: input.modelNodeId,
        handlerNodeId: input.handlerNodeId,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        toolNodeIds: input.toolNodeIds,
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
    const factories = new Map<string, HandlerFactory>([['SimpleHandler', buildSimpleHandler]]);
    return {
        build(name, input) {
            if (input.handlerGraph) {
                return buildGraphHandler(input.handlerGraph, input);
            }
            const factory = factories.get(name);
            if (!factory) {
                throw new Error(`unknown handler "${name}"`);
            }
            return factory(input);
        },
        register(name, factory) {
            factories.set(name, factory);
        },
    };
}
