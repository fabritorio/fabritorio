import type { ModelNode, SkillNode, SkillPackNode, WorkspaceNode } from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';

export interface CliInvocationConfig {
    provider: string | undefined;
    model: string | undefined;
    cwd: string | undefined;
    skillNames: string[];
}

export const EMPTY_CLI_INVOCATION_CONFIG: CliInvocationConfig = {
    provider: undefined,
    model: undefined,
    cwd: undefined,
    skillNames: [],
};

export interface ReadCliInvocationDeps {
    graphStore: GraphStore;
}

export async function readCliInvocation(
    deps: ReadCliInvocationDeps,
    refId: string | undefined,
    agentId: string,
): Promise<CliInvocationConfig> {
    if (!refId) return EMPTY_CLI_INVOCATION_CONFIG;
    const inner = await deps.graphStore.get(refId);
    if (!inner) {
        throw new Error(`agent ${agentId}: cli_invocation graph ${refId} not found`);
    }
    if (inner.kind !== 'cli_invocation') {
        throw new Error(
            `agent ${agentId}: graph ${refId} has kind ${inner.kind} (expected cli_invocation)`,
        );
    }

    let provider: string | undefined;
    let model: string | undefined;
    let cwd: string | undefined;
    const seen = new Set<string>();
    const skillNames: string[] = [];

    const addSkill = (sn: SkillNode): void => {
        if (sn.name.length === 0 || seen.has(sn.name)) return;
        seen.add(sn.name);
        skillNames.push(sn.name);
    };

    for (const node of inner.nodes) {
        if (node.type === 'model') {
            const mn = node as ModelNode;
            if (mn.provider.length > 0) provider = mn.provider;
            if (mn.model_id.length > 0) model = mn.model_id;
        } else if (node.type === 'workspace') {
            const wn = node as WorkspaceNode;
            if (wn.path.length > 0) cwd = wn.path;
        } else if (node.type === 'skill') {
            addSkill(node as SkillNode);
        } else if (node.type === 'skill_pack') {
            const pn = node as SkillPackNode;
            if (!pn.ref_id) continue;
            const pack = await deps.graphStore.get(pn.ref_id);
            if (!pack) {
                throw new Error(
                    `agent ${agentId}: cli_invocation references missing skill_pack ${pn.ref_id}`,
                );
            }
            if (pack.kind !== 'skillpack') {
                throw new Error(
                    `agent ${agentId}: skill_pack ${pn.ref_id} has kind ${pack.kind} (expected skillpack)`,
                );
            }
            for (const inside of pack.nodes) {
                if (inside.type === 'skill') addSkill(inside as SkillNode);
            }
        }
    }

    return { provider, model, cwd, skillNames };
}

export async function cliInvocationDependencies(
    deps: ReadCliInvocationDeps,
    refId: string | undefined,
): Promise<string[]> {
    if (!refId) return [];
    const inner = await deps.graphStore.get(refId);
    if (!inner || inner.kind !== 'cli_invocation') return [];
    const out: string[] = [refId];
    for (const node of inner.nodes) {
        if (node.type === 'skill_pack') {
            const pn = node as SkillPackNode;
            if (typeof pn.ref_id === 'string' && pn.ref_id.length > 0) {
                out.push(pn.ref_id);
            }
        }
    }
    return out;
}
