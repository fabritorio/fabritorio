import type { FastifyInstance } from 'fastify';
import { isValidSkillName, type SkillRegistry } from '../runtime/skills.js';

export interface SkillRoutesDeps {
    skillRegistry: SkillRegistry;
}

interface NameParam {
    name: string;
}

export function registerSkillRoutes(app: FastifyInstance, deps: SkillRoutesDeps): void {
    app.get('/skills', async () => {
        deps.skillRegistry.rescan();
        return { skills: deps.skillRegistry.list() };
    });

    app.get<{ Params: NameParam }>('/skills/:name', async (req, reply) => {
        deps.skillRegistry.rescan();
        const name = decodeURIComponent(req.params.name);
        const detail = deps.skillRegistry.read(name);
        if (!detail) {
            return reply.code(404).send({ error: `unknown skill: ${name}` });
        }
        return reply.send(detail);
    });

    app.put<{ Params: NameParam; Body: { content?: unknown } }>(
        '/skills/:name',
        async (req, reply) => {
            const name = decodeURIComponent(req.params.name);
            if (!isValidSkillName(name)) {
                return reply.code(400).send({
                    error: `invalid skill name: ${name} (use letters, digits, ._- and lead with an alphanumeric)`,
                });
            }
            const content = req.body?.content;
            if (typeof content !== 'string') {
                return reply.code(400).send({ error: 'body.content must be a string' });
            }
            const detail = deps.skillRegistry.save(name, content);
            return reply.send(detail);
        },
    );
}
