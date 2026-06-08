import { describe, expect, it } from 'vitest';
import type { ToolSpecSummary } from '../lib/runner-client';
import {
    applyConfigField,
    configFieldValue,
    configSchemaFor,
    enumEmptyOptionLabel,
    visibleConfigFields,
} from '../lib/tool-config';

const fetchTool: ToolSpecSummary = {
    name: 'fetch',
    description: 'Fetch a URL over HTTP(S).',
    source: 'builtin',
    config_schema: [
        {
            name: 'mode',
            kind: 'enum',
            label: 'Mode',
            options: ['markdown', 'raw', 'json', 'soup'],
            description: 'Pin the output mode.',
        },
        {
            name: 'selector',
            kind: 'string',
            label: 'CSS selector',
            placeholder: 'e.g. article h2',
            description: 'Pin the soup selector.',
            showWhen: { field: 'mode', equals: 'soup' },
        },
    ],
};

const readFile: ToolSpecSummary = {
    name: 'read_file',
    description: 'Read a file.',
    source: 'builtin',
};

const webSearchTool: ToolSpecSummary = {
    name: 'web_search',
    description: 'Search the web.',
    source: 'builtin',
    config_schema: [
        {
            name: 'provider',
            kind: 'enum',
            label: 'Provider',
            required: true,
            options: ['tavily', 'brave'],
            description: 'Which search API to call.',
        },
    ],
};

describe('configSchemaFor', () => {
    it('returns the selected tool config_schema, looked up by tool_name', () => {
        const schema = configSchemaFor([readFile, fetchTool], 'fetch');
        expect(schema.map((f) => f.name)).toEqual(['mode', 'selector']);
    });

    it('returns [] for a tool with no config_schema (every tool but fetch today)', () => {
        expect(configSchemaFor([readFile, fetchTool], 'read_file')).toEqual([]);
    });

    it('returns [] for an unknown tool name and a null catalog', () => {
        expect(configSchemaFor([fetchTool], 'nope')).toEqual([]);
        expect(configSchemaFor(null, 'fetch')).toEqual([]);
    });
});

describe('visibleConfigFields — Mode select + showWhen', () => {
    const schema = configSchemaFor([fetchTool], 'fetch');

    it('renders the Mode enum (with options) and hides selector when unconfigured', () => {
        const visible = visibleConfigFields(schema, undefined);
        expect(visible.map((f) => f.name)).toEqual(['mode']);
        const mode = visible[0]!;
        expect(mode.kind).toBe('enum');
        expect(mode.options).toContain('soup');
    });

    it('hides selector unless config.mode === "soup"', () => {
        expect(visibleConfigFields(schema, { mode: 'markdown' }).map((f) => f.name)).toEqual([
            'mode',
        ]);
    });

    it('shows selector when config.mode === "soup"', () => {
        expect(visibleConfigFields(schema, { mode: 'soup' }).map((f) => f.name)).toEqual([
            'mode',
            'selector',
        ]);
    });
});

describe('configFieldValue — unpinned default is the "Model decides" option', () => {
    it('is "" when the key is unset (selects the prepended unpinned option)', () => {
        expect(configFieldValue(undefined, 'mode')).toBe('');
        expect(configFieldValue({}, 'mode')).toBe('');
    });

    it('is the pinned string when set', () => {
        expect(configFieldValue({ mode: 'json' }, 'mode')).toBe('json');
    });
});

describe('enumEmptyOptionLabel — required enum suppresses "Model decides"', () => {
    it('a non-required (pinnable-param) enum keeps the model-decides option', () => {
        const mode = configSchemaFor([fetchTool], 'fetch').find((f) => f.name === 'mode')!;
        expect(mode.required).toBeUndefined();
        expect(enumEmptyOptionLabel(mode)).toBe('Model decides (per call)');
    });

    it('a required enum (web_search.provider) renders "(select…)" instead', () => {
        const provider = configSchemaFor([webSearchTool], 'web_search').find(
            (f) => f.name === 'provider',
        )!;
        expect(provider.required).toBe(true);
        const label = enumEmptyOptionLabel(provider);
        expect(label).toBe('(select…)');
        expect(label).not.toMatch(/Model decides/);
    });

    it('provider is config-only — the schema exposes no per-call model param for it', () => {
        const schema = configSchemaFor([webSearchTool], 'web_search');
        expect(schema.map((f) => f.name)).toEqual(['provider']);
    });
});

describe('applyConfigField — onChange diff', () => {
    it('selecting a mode sets config[name] without mutating the input', () => {
        const before = {};
        const after = applyConfigField(before, 'mode', 'json');
        expect(after).toEqual({ mode: 'json' });
        expect(before).toEqual({});
    });

    it('clearing a mode ("Model decides") deletes the key', () => {
        const after = applyConfigField({ mode: 'soup', selector: '.x' }, 'mode', '');
        expect(after).toEqual({ selector: '.x' });
        expect('mode' in after).toBe(false);
    });

    it('writing a string field sets it; emptying it deletes it', () => {
        expect(applyConfigField({ mode: 'soup' }, 'selector', 'article h2')).toEqual({
            mode: 'soup',
            selector: 'article h2',
        });
        expect(applyConfigField({ mode: 'soup', selector: 'article h2' }, 'selector', '')).toEqual({
            mode: 'soup',
        });
    });
});
