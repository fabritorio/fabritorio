export const REDACTION_PLACEHOLDER = '«redacted»';

export function redactSecrets(text: string, values: string[]): string {
    if (values.length === 0) return text;
    let out = text;
    for (const v of values) {
        if (v.length === 0) continue;
        out = out.split(v).join(REDACTION_PLACEHOLDER);
    }
    return out;
}
