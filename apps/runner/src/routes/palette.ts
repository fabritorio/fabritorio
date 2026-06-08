import type { FastifyInstance } from 'fastify';
import { palette } from '../graphs/palette.js';

export function registerPaletteRoutes(app: FastifyInstance): void {
    app.get('/palette', async () => {
        return palette;
    });
}
