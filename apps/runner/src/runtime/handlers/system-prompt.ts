export interface HandlerSkillSummary {
    name: string;
    description: string;
}

export function buildSystemPrompt(args: {
    modelSystemPrompt?: string;
    skills: HandlerSkillSummary[];
    injectedMemoryBlock?: string;
}): string {
    const parts: string[] = [];
    if (args.modelSystemPrompt && args.modelSystemPrompt.trim().length > 0) {
        parts.push(args.modelSystemPrompt.trim());
    }
    if (args.skills.length > 0) {
        const lines = ['Available skills (load full body via the Skill tool):'];
        for (const s of args.skills) {
            lines.push(`- ${s.name}: ${s.description}`);
        }
        parts.push(lines.join('\n'));
    }
    const block = args.injectedMemoryBlock?.trim();
    if (block && block.length > 0) parts.push(block);
    return parts.join('\n\n');
}

export function resolveSystemPrompt(sp: string | (() => string)): string {
    return typeof sp === 'function' ? sp() : sp;
}
