import type { FastifyInstance } from 'fastify';
import {
    deleteMarkdownMemoryFile,
    isSafeMemoryNodeId,
    readMarkdownMemoryFile,
    writeMarkdownMemoryFile,
    type MemoryRegistry,
} from '../runtime/memory.js';

export interface MemoryRoutesDeps {
    memory: MemoryRegistry;
    memoryDir: string;
}

interface NodeParam {
    nodeId: string;
}

interface KeyParam extends NodeParam {
    key: string;
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRoutesDeps): void {
    app.get<{ Params: NodeParam }>('/memory/:nodeId', async (req, reply) => {
        const handle = deps.memory.get(req.params.nodeId);
        if (!handle) {
            return reply.code(404).send({ error: 'memory not loaded' });
        }
        return reply.send({
            nodeId: handle.nodeId,
            entries: handle.snapshot(),
        });
    });

    app.put<{ Params: KeyParam; Body: unknown }>('/memory/:nodeId/:key', async (req, reply) => {
        const handle = deps.memory.get(req.params.nodeId);
        if (!handle) {
            return reply.code(404).send({ error: 'memory not loaded' });
        }
        const key = decodeURIComponent(req.params.key);
        handle.write(key, req.body);
        return reply.send({ nodeId: handle.nodeId, key, value: req.body });
    });

    app.delete<{ Params: KeyParam }>('/memory/:nodeId/:key', async (req, reply) => {
        const handle = deps.memory.get(req.params.nodeId);
        if (!handle) {
            return reply.code(404).send({ error: 'memory not loaded' });
        }
        const key = decodeURIComponent(req.params.key);
        handle.delete(key);
        return reply.code(204).send();
    });

    app.get<{ Params: NodeParam }>('/memory-file/:nodeId', async (req, reply) => {
        const nodeId = decodeURIComponent(req.params.nodeId);
        if (!isSafeMemoryNodeId(nodeId)) {
            return reply.code(400).send({ error: `invalid memory node id: ${nodeId}` });
        }
        return reply.send({
            nodeId,
            content: readMarkdownMemoryFile(deps.memoryDir, nodeId) ?? '',
        });
    });

    app.put<{ Params: NodeParam; Body: { content?: unknown } }>(
        '/memory-file/:nodeId',
        async (req, reply) => {
            const nodeId = decodeURIComponent(req.params.nodeId);
            if (!isSafeMemoryNodeId(nodeId)) {
                return reply.code(400).send({ error: `invalid memory node id: ${nodeId}` });
            }
            const content = req.body?.content;
            if (typeof content !== 'string') {
                return reply.code(400).send({ error: 'body.content must be a string' });
            }
            writeMarkdownMemoryFile(deps.memoryDir, nodeId, content);
            return reply.send({ nodeId, content });
        },
    );

    app.delete<{ Params: NodeParam }>('/memory-file/:nodeId', async (req, reply) => {
        const nodeId = decodeURIComponent(req.params.nodeId);
        if (!isSafeMemoryNodeId(nodeId)) {
            return reply.code(400).send({ error: `invalid memory node id: ${nodeId}` });
        }
        deleteMarkdownMemoryFile(deps.memoryDir, nodeId);
        return reply.code(204).send();
    });
}
