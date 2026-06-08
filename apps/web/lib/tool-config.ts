import type { ToolConfigField, ToolSpecSummary } from './runner-client';

export type ToolNodeConfig = Record<string, unknown>;

export function configSchemaFor(
    tools: ToolSpecSummary[] | null,
    toolName: string,
): ToolConfigField[] {
    if (!tools) return [];
    const match = tools.find((t) => t.name === toolName);
    return match?.config_schema ?? [];
}

export function visibleConfigFields(
    schema: ToolConfigField[],
    config: ToolNodeConfig | undefined,
): ToolConfigField[] {
    return schema.filter((field) => {
        if (!field.showWhen) return true;
        return config?.[field.showWhen.field] === field.showWhen.equals;
    });
}

export function enumEmptyOptionLabel(field: ToolConfigField): string {
    return field.required ? '(select…)' : 'Model decides (per call)';
}

export function configFieldValue(config: ToolNodeConfig | undefined, name: string): string {
    const raw = config?.[name];
    return typeof raw === 'string' ? raw : '';
}

export function applyConfigField(
    config: ToolNodeConfig | undefined,
    name: string,
    value: string,
): ToolNodeConfig {
    const next: ToolNodeConfig = { ...config };
    if (value === '') {
        delete next[name];
    } else {
        next[name] = value;
    }
    return next;
}
