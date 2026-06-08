import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadConfig } from '../src/config.js';

const originalPort = process.env.PORT;
const originalHost = process.env.HOST;

function restoreEnv() {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalHost === undefined) delete process.env.HOST;
    else process.env.HOST = originalHost;
}

describe('loadConfig', () => {
    beforeEach(() => {
        delete process.env.PORT;
        delete process.env.HOST;
    });

    afterAll(() => {
        restoreEnv();
    });

    it('defaults to port 4000 when PORT is unset', () => {
        expect(loadConfig().port).toBe(4000);
    });

    it('defaults to port 4000 when PORT is empty string', () => {
        process.env.PORT = '';
        expect(loadConfig().port).toBe(4000);
    });

    it('parses PORT when set to a valid integer', () => {
        process.env.PORT = '8080';
        expect(loadConfig().port).toBe(8080);
    });

    it('throws on non-integer strings', () => {
        process.env.PORT = 'nope';
        expect(() => loadConfig()).toThrow(/Invalid PORT/);
    });

    it('throws on zero', () => {
        process.env.PORT = '0';
        expect(() => loadConfig()).toThrow(/Invalid PORT/);
    });

    it('throws on negative values', () => {
        process.env.PORT = '-1';
        expect(() => loadConfig()).toThrow(/Invalid PORT/);
    });

    it('throws on values above 65535', () => {
        process.env.PORT = '65536';
        expect(() => loadConfig()).toThrow(/Invalid PORT/);
    });

    it('defaults host to 127.0.0.1 (localhost-only)', () => {
        expect(loadConfig().host).toBe('127.0.0.1');
    });

    it('defaults host to 127.0.0.1 when HOST is empty string', () => {
        process.env.HOST = '';
        expect(loadConfig().host).toBe('127.0.0.1');
    });

    it('honors HOST when set (e.g. 0.0.0.0 for LAN)', () => {
        process.env.HOST = '0.0.0.0';
        expect(loadConfig().host).toBe('0.0.0.0');
    });
});
