import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import type { Palette } from '@fabritorio/types';
import { inject } from './helpers/inject.js';

describe('GET /palette', () => {
    it('returns 200 with the palette schema', async () => {
        const app = buildServer({ logger: false });
        try {
            const res = await inject(app, { method: 'GET', url: '/api/palette' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as Palette;
            expect(typeof body.version).toBe('number');
            expect(body.nodes).toBeDefined();
            expect(body.connections).toBeDefined();
            expect(body.compositeKinds).toBeDefined();
        } finally {
            await app.close();
        }
    });

    it('exposes the handler node spec with the canonical port set', async () => {
        const app = buildServer({ logger: false });
        try {
            const res = await inject(app, { method: 'GET', url: '/api/palette' });
            const body = res.json() as Palette;
            const handler = body.nodes.handler;
            expect(handler).toBeDefined();
            const inIds = handler?.inPorts.map((p) => p.id).sort();
            expect(inIds).toEqual(['gateway-in', 'skills-in', 'tools-in', 'workspace-in']);
            const outIds = handler?.outPorts.map((p) => p.id).sort();
            expect(outIds).toEqual(['model-out', 'output-out']);
            expect(handler?.defaultedFields).toContain('max_iterations');
        } finally {
            await app.close();
        }
    });

    it('lists Gateway → Handler as a legal L1 connection', async () => {
        const app = buildServer({ logger: false });
        try {
            const res = await inject(app, { method: 'GET', url: '/api/palette' });
            const body = res.json() as Palette;
            const l1 = body.connections.l1 ?? [];
            const match = l1.find((r) => r.source === 'gateway' && r.target === 'handler');
            expect(match).toBeDefined();
            expect(match?.sourcePort).toBe('gateway-out');
            expect(match?.targetPort).toBe('gateway-in');
        } finally {
            await app.close();
        }
    });

    it('lists Channel → NativeAgent as a legal L2 connection', async () => {
        const app = buildServer({ logger: false });
        try {
            const res = await inject(app, { method: 'GET', url: '/api/palette' });
            const body = res.json() as Palette;
            const l2 = body.connections.l2 ?? [];
            const match = l2.find((r) => r.source === 'channel' && r.target === 'native_agent');
            expect(match).toBeDefined();
        } finally {
            await app.close();
        }
    });

    it('toolpack composite kind allows only tool / tool_pack', async () => {
        const app = buildServer({ logger: false });
        try {
            const res = await inject(app, { method: 'GET', url: '/api/palette' });
            const body = res.json() as Palette;
            const spec = body.compositeKinds.toolpack;
            expect(spec).toBeDefined();
            expect(spec?.allowedNodeTypes.sort()).toEqual(['tool', 'tool_pack']);
            expect(spec?.decorativeEdges).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('l1 composite kind carries the single-gateway topology hint', async () => {
        const app = buildServer({ logger: false });
        try {
            const res = await inject(app, { method: 'GET', url: '/api/palette' });
            const body = res.json() as Palette;
            const spec = body.compositeKinds.l1;
            expect(spec).toBeDefined();
            expect(spec?.topology?.singleGateway).toBe(true);
            expect(spec?.allowedNodeTypes).toContain('handler');
            expect(spec?.allowedNodeTypes).not.toContain('channel');
        } finally {
            await app.close();
        }
    });
});
