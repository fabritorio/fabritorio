import type { ModelNode } from '@fabritorio/types';
import type { ModelClient } from '../model.js';
import { createOpenAIClient } from './openai-compat.js';
import { createGeminiClient } from './gemini.js';
import { createAnthropicClient } from './anthropic.js';

const MANAGED_CLOUD_HOSTS = [
    'api.openai.com',
    'api.anthropic.com',
    'openrouter.ai',
    'ai-gateway.vercel.sh',
];

function supportsChatTemplateThinking(baseUrl?: string): boolean {
    if (!baseUrl) return false;
    return !MANAGED_CLOUD_HOSTS.some((host) => baseUrl.includes(host));
}

export function defaultModelClientFor(node: ModelNode): ModelClient {
    const apiKey = (node.auth_env ? process.env[node.auth_env] : undefined) ?? '';
    const opts = {
        apiKey,
        ...(node.base_url ? { baseUrl: node.base_url } : {}),
    };
    switch (node.provider) {
        case 'gemini':
        case 'google':
            return createGeminiClient(opts);
        case 'anthropic':
            return createAnthropicClient(opts);
        default:
            return createOpenAIClient({
                ...opts,
                chatTemplateThinking: supportsChatTemplateThinking(node.base_url),
            });
    }
}
