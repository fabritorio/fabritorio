import type {
    CheckpointNode,
    Edge,
    Graph,
    GatewayNode,
    HandlerNode,
    MemoryNode,
    ModelNode,
    ModelRouterNode,
    Node,
    NodeType,
    OutputNode,
    PermissionNode,
    SecretBinding,
    SecretsNode,
    SkillNode,
    SkillPackNode,
    ToolNode,
    ToolPackNode,
    WorkspaceNode,
} from '@fabritorio/types';
import type { GraphStore } from '../../graphs/store.js';
import {
    createAskAgentTools,
    createBashTool,
    createCreateGraphTool,
    createEditFileTool,
    createEditGraphTool,
    createInstantiateCompositeTool,
    createListDirectoryTool,
    createMemoryReadTool,
    createMemoryWriteTool,
    createPriorTurnsTool,
    createReadCanvasTool,
    createReadFileTool,
    createReadGraphTool,
    createWriteFileTool,
    type BuiltinToolBuildCtx,
    type WorkspaceBinding,
} from '../builtin-tools.js';
import { createWebFetchTool } from '../web-fetch-tool.js';
import { createWebSearchTool } from '../web-search-tool.js';
import type { GraphRuntimeRegistry } from '../graph-runtime.js';
import type { Handler } from '../handlers/handler.js';
import type { HandlerRegistry } from '../handlers/registry.js';
import { buildSystemPrompt, type SimpleHandlerSkill } from '../handlers/simple.js';
import type { MemoryHandle } from '../memory.js';
import { renderInjectedMemoryBlock } from '../memory.js';
import type { ModelClient } from '../model.js';
import { createRouterClient, type RouterChild } from '../providers/router.js';
import { getOrCreatePermissionGate } from '../bindings/permission.js';
import type { PermissionGateHandle, PermissionGateRegistry } from '../permission.js';
import { createCheckpointHandle, type CheckpointBinding } from '../checkpoint.js';
import { createRuntimeToolFromManifest, type RuntimeToolRegistry } from '../runtime-tools.js';
import type { SecretsStore } from '../secrets-store.js';
import type { SkillRegistry } from '../skills.js';
import { createSkillTool, getCurrentTimeTool, type Tool } from '../tools.js';
import { expandHomePath } from './wiring.js';

/**
 * Resolve an L1 graph into a runnable Handler. Both `native_agent` (with
 * a Memory wrapper) and `debug_gateway` (without) build off this — the L1
 * "shape" is identical regardless of who's driving it. Memory binding stays
 * at the L2 layer where MemoryNodes live.
 */

export interface BuildHandlerFromL1Deps {
    graphStore: GraphStore;
    skillRegistry: SkillRegistry;
    modelClientFor: (node: ModelNode) => ModelClient;
    handlerRegistry: HandlerRegistry;
    /**
     * Per-graph permission-gate registry. The L1 builder walks PermissionNodes
     * wired between Tool/ToolPack and the Handler, looks up the active gate
     * here, and threads it down so `runToolExec` can intercept the tool call
     * before firing. Optional: callers (e.g. tests) that don't host gates can
     * omit it and PermissionNodes in the L1 silently fall through to ungated.
     */
    permissionGateRegistry?: PermissionGateRegistry;
    /**
     * Runner's `GraphRuntimeRegistry`. Threaded through so the cross-graph
     * write tools (`create_graph`, `edit_graph`) can run their input through
     * the same persist pipeline the HTTP routes use — including the
     * topology-diff + selective runtime reload. Optional: tests that don't
     * exercise the write tools can omit it (the tools still load but refuse
     * at call time, same shape as the GraphStore-required tools).
     */
    runtimes?: GraphRuntimeRegistry;
    /**
     * Per-Dispatch context lookup shared by built-in tools that need the
     * in-flight Dispatch (`ask_agent`, `prior_turns`). The NativeAgent
     * binding builds this at activate time (capturing the L2 graph's outgoing
     * edges and `topicFor`) and threads a `currentContext()` getter that
     * returns the in-flight Dispatch when a Handler is mid-loop. Optional:
     * tests that don't exercise agent coordination or session lookup leave it
     * unset and the relevant tools refuse at call time with a clear "no
     * in-flight Dispatch context" message — same shape as the other
     * registry-required tools.
     */
    builtinToolBuildCtx?: BuiltinToolBuildCtx;
    /**
     * Filesystem-backed registry of user-authored tools (manifest + binary
     * under `~/.fabritorio/tools/`). When a ToolNode names something that's
     * not a built-in, `createBuiltinTool` consults this registry — miss
     * triggers a single `rescan()` retry (mirroring `createSkillTool`), so a
     * fresh CLI build shows up without restarting the runner. Optional in
     * tests; without it, a ToolNode naming a non-built-in throws as before.
     */
    runtimeToolRegistry?: RuntimeToolRegistry;
    /**
     * In-memory credential store backing SecretsNodes. The L1 builder walks
     * `secrets → tool` / `secrets → tool_pack` edges, collects the static
     * `bindings` (names/sources — never values) per tool node, and threads a
     * late-resolution thunk into each runtime-tool factory. The thunk reads
     * this store per call (rescanning at the use-point), so a rotated or
     * newly added secret is picked up on the next dispatch without rebuilding
     * the handler — see "Hot reload" in `docs/secrets-node.md`. Optional:
     * when absent, every tool resolves to an empty secret env (preserves
     * today's behavior).
     */
    secretsStore?: SecretsStore;
}

export interface BuildHandlerFromL1Options {
    /**
     * Memory nodes with `handling: 'always_inject'` wired to the agent. Each
     * one contributes a section to the system prompt — `static_string` reads
     * inline `content`, `markdown` reads from the resolved handle. NativeAgent
     * supplies these from its L2 wiring; DebugGateway from the parent agent's.
     */
    injectedMemories?: MemoryNode[];
    /**
     * Resolver for markdown-storage memories in `injectedMemories`. Closes over
     * the binding's `MemoryRegistry` so the prompt thunk picks up writes
     * between Dispatches without rebuilding the Handler. Required when any
     * markdown-storage memory is in `injectedMemories`.
     */
    resolveInjectedHandle?: (node: MemoryNode) => MemoryHandle | undefined;
    /**
     * Resolved handle for the wired tool-access markdown Memory node. When
     * supplied, the L1 builder binds `memory_read` / `memory_write` to this
     * handle. Caller resolves via `MemoryRegistry.resolve`.
     */
    toolMemoryHandle?: MemoryHandle;
    /** Caller label used to prefix thrown errors (e.g. "native_agent agent-1"). */
    ownerLabel?: string;
}

export interface HandlerFromL1Result {
    handler: Handler;
    /** L1 Output node id — used for `output.emitted` observability tagging. */
    outputNodeId: string;
    /** L1 Handler node id — exposed for the same reason. */
    handlerNodeId: string;
}

export async function buildHandlerFromL1(
    l1: Graph,
    deps: BuildHandlerFromL1Deps,
    opts: BuildHandlerFromL1Options = {},
): Promise<HandlerFromL1Result> {
    const ownerLabel = opts.ownerLabel ?? `l1 ${l1.id ?? '(unsaved)'}`;
    const handler = pickOne(l1, 'handler') as HandlerNode | undefined;
    const gateway = pickOne(l1, 'gateway') as GatewayNode | undefined;
    const output = pickOne(l1, 'output') as OutputNode | undefined;
    if (!handler) throw new Error(`${ownerLabel}: L1 missing Handler node`);
    if (!gateway) throw new Error(`${ownerLabel}: L1 missing Gateway node`);
    if (!output) throw new Error(`${ownerLabel}: L1 missing Output node`);

    const wiredToHandler = nodesConnectedTo(l1, handler.id);
    const directModel = wiredToHandler.find((n): n is ModelNode => n.type === 'model');
    const directRouter = wiredToHandler.find(
        (n): n is ModelRouterNode => n.type === 'model_router',
    );
    if (directModel && directRouter) {
        throw new Error(
            `${ownerLabel}: Handler has both a Model and a ModelRouter wired — exactly one is allowed`,
        );
    }
    if (!directModel && !directRouter) {
        throw new Error(`${ownerLabel}: Handler has no Model wired`);
    }

    // Headline Model: the priority-0 leaf the user wired topmost. Its config
    // (model_id, node id, system_prompt, temperature, max_tokens) flows into
    // the Handler factory. Failover children use their own model_id at call
    // time — the synthetic router client rewrites `req.model` per attempt.
    //
    // Step-4 simplification (departs from docs/model-router.md's per-attempt
    // modelId note): `graph-handler.ts`'s `llm.request` / `llm.response`
    // events will continue to report the headline Model's id even when
    // failover routes elsewhere. The router-scoped events arriving in Step 6
    // (`model_router.attempted` / `.fell_through`) provide the "actually
    // answered" signal in the trace.
    const modelNode: ModelNode = directModel
        ? directModel
        : resolveHeadlineModel(directRouter!, l1, ownerLabel);

    const toolNodes = wiredToHandler.filter((n): n is ToolNode => n.type === 'tool');
    const toolPackNodes = wiredToHandler.filter((n): n is ToolPackNode => n.type === 'tool_pack');
    const skillNodes = wiredToHandler.filter((n): n is SkillNode => n.type === 'skill');
    const skillPackNodes = wiredToHandler.filter(
        (n): n is SkillPackNode => n.type === 'skill_pack',
    );
    const workspaceNode = wiredToHandler.find((n): n is WorkspaceNode => n.type === 'workspace');

    // Expand a leading `~` so users can type `~/.fabritorio/...` in the
    // Workspace inspector without ending up with literal-`~` subtrees on
    // disk (write_file / edit_file resolve paths via Node's `path.resolve`,
    // which doesn't expand tildes — that's a shell feature). CliAgent
    // already does this for its cwd; mirroring it here closes the same
    // foot-gun for built-in tools.
    const workspace: WorkspaceBinding | null = workspaceNode
        ? {
              path: expandHomePath(workspaceNode.path) ?? workspaceNode.path,
              permissions: workspaceNode.permissions,
          }
        : null;

    const builtinCtx: BuiltinToolCtx = {
        workspace,
        toolMemoryHandle: opts.toolMemoryHandle ?? null,
        graphStore: deps.graphStore,
        runtimes: deps.runtimes ?? null,
        builtinToolBuildCtx: deps.builtinToolBuildCtx ?? null,
        l1GraphId: l1.id ?? null,
        runtimeToolRegistry: deps.runtimeToolRegistry ?? null,
    };

    // Discover Tool/ToolPack nodes that reach the Handler *via* a PermissionNode.
    // Each such tool gets gated: `runToolExec` calls into the gate's
    // `evaluate(call)` before firing the tool handler. Tools wired directly to
    // the Handler stay ungated (today's behavior).
    //
    // We register gates here too via `getOrCreatePermissionGate` so the
    // L2-wrapped path works the same as L1-standalone — the L1 itself isn't
    // loaded by the runtime when wrapped by an L2 NativeAgent, so binding.
    // activate never runs for those PermissionNodes. Get-or-create is
    // idempotent: in the L1-standalone case the binding already registered
    // and we reuse the canonical handle.
    const gatedToolBindings: Array<{
        node: ToolNode | ToolPackNode;
        gate: PermissionGateHandle;
    }> = [];
    if (deps.permissionGateRegistry && l1.id) {
        const registry = deps.permissionGateRegistry;
        const l1Id = l1.id;
        const permissionNodes = l1.nodes.filter(
            (n): n is PermissionNode => n.type === 'permission',
        );
        for (const pn of permissionNodes) {
            const wiresToHandler = (l1.edges as Edge[]).some(
                (e) => e.source.node_id === pn.id && e.target.node_id === handler.id,
            );
            if (!wiresToHandler) continue;
            const gate = getOrCreatePermissionGate(registry, l1Id, pn.id);
            for (const e of l1.edges as Edge[]) {
                if (e.target.node_id !== pn.id) continue;
                const src = l1.nodes.find((n) => n.id === e.source.node_id);
                if (!src) continue;
                if (src.type === 'tool' || src.type === 'tool_pack') {
                    gatedToolBindings.push({
                        node: src as ToolNode | ToolPackNode,
                        gate,
                    });
                }
            }
        }
    }

    // Discover CheckpointNodes wired to the Handler. Each one anchors a
    // meta-cognition consult: at its cadence the evaluator pauses and asks the
    // ghosted L2 strategy agent (`agent_id`) what to do. Mirrors the
    // PermissionNode discovery above. Reachability to the strategy agent rides
    // the same `ask_agent` edge gate (checked at consult time against the host
    // L2's outgoing edges), so there's no parallel reachability graph here —
    // we only need the in-flight Dispatch context the consult publishes on.
    const checkpoints: CheckpointBinding[] = [];
    if (deps.builtinToolBuildCtx && l1.id) {
        const buildCtx = deps.builtinToolBuildCtx;
        const l1Id = l1.id;
        const checkpointNodes = l1.nodes.filter(
            (n): n is CheckpointNode => n.type === 'checkpoint',
        );
        for (const cn of checkpointNodes) {
            const wiresToHandler = (l1.edges as Edge[]).some(
                (e) => e.source.node_id === cn.id && e.target.node_id === handler.id,
            );
            if (!wiresToHandler) continue;
            checkpoints.push({
                cadence: cn.cadence,
                handle: createCheckpointHandle(buildCtx, {
                    graphId: l1Id,
                    nodeId: cn.id,
                    strategy: cn.strategy,
                    targetAgentId: cn.agent_id,
                    ...(cn.window !== undefined ? { window: cn.window } : {}),
                    ...(cn.keep_last !== undefined ? { keepLast: cn.keep_last } : {}),
                }),
            });
        }
    }

    // Discover `secrets → tool` / `secrets → tool_pack` wiring. Mirrors the
    // PermissionNode discovery above, but collects STATIC bindings (names +
    // sources, graph data) rather than resolved values — resolution is late
    // (call time) so a hot-reloaded store is picked up without rebuilding the
    // handler. See "Hot reload" in `docs/secrets-node.md`.
    const secretBindingsByToolNodeId = new Map<string, SecretBinding[]>();
    {
        const secretsNodes = l1.nodes.filter((n): n is SecretsNode => n.type === 'secrets');
        for (const sn of secretsNodes) {
            for (const e of l1.edges as Edge[]) {
                if (e.source.node_id !== sn.id) continue;
                const target = l1.nodes.find((n) => n.id === e.target.node_id);
                if (!target) continue;
                if (target.type !== 'tool' && target.type !== 'tool_pack') continue;
                // Union across multiple Secrets nodes wiring the same tool;
                // later binding wins on a `name` collision.
                const existing = secretBindingsByToolNodeId.get(target.id) ?? [];
                secretBindingsByToolNodeId.set(target.id, [...existing, ...sn.bindings]);
            }
        }
    }

    // Build the late-resolution thunk for a tool origin node. Closes over the
    // static bindings + a reference to the store, and resolves per call: it
    // rescans unconditionally at the use-point (a rotated value never surfaces
    // as a `get` miss, so the registries' rescan-on-miss wouldn't catch it),
    // then reads each binding. A miss skips the key (the binary just won't see
    // that var; don't throw). Returns an empty env when no store / no bindings.
    const resolveSecretEnvFor = (nodeId: string): (() => Record<string, string>) | undefined => {
        const bindings = secretBindingsByToolNodeId.get(nodeId);
        if (!bindings || bindings.length === 0) return undefined;
        const store = deps.secretsStore;
        return () => {
            if (!store) return {};
            store.rescan(); // use-point refresh — see "Hot reload"
            const out: Record<string, string> = {};
            for (const b of bindings) {
                // Blank source → `env:<name>` default. The Inspector stores an
                // empty string (not undefined) when the user leaves source
                // blank — which the placeholder invites — so `??` alone wouldn't
                // catch it; treat empty/whitespace as omitted.
                const rawSource =
                    b.source && b.source.trim().length > 0 ? b.source : `env:${b.name}`;
                const key = parseSecretSource(rawSource);
                const v = store.get(key);
                if (v !== undefined) out[b.name] = v;
            }
            return out;
        };
    };

    const tools: Tool[] = [];
    const toolNodeIds = new Map<string, string>();
    const permissionByToolName = new Map<string, PermissionGateHandle>();
    const addTool = (tool: Tool, originNodeId: string, gate: PermissionGateHandle | null) => {
        if (toolNodeIds.has(tool.spec.name)) return;
        tools.push(tool);
        toolNodeIds.set(tool.spec.name, originNodeId);
        if (gate) permissionByToolName.set(tool.spec.name, gate);
    };

    // Resolve one tool node's `tool_name` into the concrete tool(s) it adds.
    // `ask_agent` fans out to one `ask_agent_<name>` tool per reachable callee
    // (the model picks the delegate, not a free-form target id); everything
    // else resolves to the single built-in/runtime tool — `null` when unknown,
    // so each loop keeps its own not-found message. Shared by all three
    // resolution loops so the fan-out lives in exactly one place.
    const resolveTools = (
        toolName: string,
        resolveSecretEnv?: () => Record<string, string>,
        config?: Record<string, unknown>,
    ): Tool[] | null => {
        if (toolName === 'ask_agent') {
            return createAskAgentTools(builtinCtx.builtinToolBuildCtx);
        }
        const tool = createBuiltinTool(toolName, builtinCtx, resolveSecretEnv, config);
        return tool ? [tool] : null;
    };

    // Process gated tools first so a tool wired both directly and through a
    // gate ends up gated. Fail-secure ordering for the (rare, unintentional)
    // double-wire case.
    for (const { node, gate } of gatedToolBindings) {
        if (node.type === 'tool') {
            const resolved = resolveTools(
                node.tool_name,
                resolveSecretEnvFor(node.id),
                node.config,
            );
            if (!resolved) {
                throw new Error(
                    `${ownerLabel}: unknown tool "${node.tool_name}" wired through Permission node`,
                );
            }
            for (const tool of resolved) addTool(tool, node.id, gate);
        } else {
            // tool_pack — same expansion as the direct path below.
            if (!node.ref_id) continue;
            const l0 = await deps.graphStore.get(node.ref_id);
            if (!l0) {
                throw new Error(
                    `${ownerLabel}: tool_pack ${node.id} references missing L0 graph ${node.ref_id}`,
                );
            }
            if (l0.kind !== 'toolpack') {
                throw new Error(
                    `${ownerLabel}: tool_pack ${node.id} references graph ${node.ref_id} of kind ${l0.kind} (expected toolpack)`,
                );
            }
            const resolveSecretEnv = resolveSecretEnvFor(node.id);
            const inner = l0.nodes.filter((n): n is ToolNode => n.type === 'tool');
            for (const tn of inner) {
                // Tool-pack inner nodes: pass the inner ToolNode's own `.config`
                // — config lives on the inner node, consistent with by-value
                // composite semantics (the pack copied the inner node verbatim).
                const resolved = resolveTools(tn.tool_name, resolveSecretEnv, tn.config);
                if (!resolved) {
                    throw new Error(
                        `${ownerLabel}: tool_pack ${node.id} contains unknown tool "${tn.tool_name}"`,
                    );
                }
                for (const tool of resolved) addTool(tool, node.id, gate);
            }
        }
    }

    for (const tn of toolNodes) {
        const resolved = resolveTools(tn.tool_name, resolveSecretEnvFor(tn.id), tn.config);
        if (!resolved) {
            throw new Error(`${ownerLabel}: unknown tool "${tn.tool_name}" wired to Handler`);
        }
        for (const tool of resolved) addTool(tool, tn.id, null);
    }

    for (const pn of toolPackNodes) {
        if (!pn.ref_id) continue;
        const l0 = await deps.graphStore.get(pn.ref_id);
        if (!l0) {
            throw new Error(
                `${ownerLabel}: tool_pack ${pn.id} references missing L0 graph ${pn.ref_id}`,
            );
        }
        if (l0.kind !== 'toolpack') {
            throw new Error(
                `${ownerLabel}: tool_pack ${pn.id} references graph ${pn.ref_id} of kind ${l0.kind} (expected toolpack)`,
            );
        }
        const resolveSecretEnv = resolveSecretEnvFor(pn.id);
        const inner = l0.nodes.filter((n): n is ToolNode => n.type === 'tool');
        for (const tn of inner) {
            // Tool-pack inner config rides on the inner ToolNode (by-value
            // composite semantics) — pass `tn.config`, not the pack node's.
            const resolved = resolveTools(tn.tool_name, resolveSecretEnv, tn.config);
            if (!resolved) {
                throw new Error(
                    `${ownerLabel}: tool_pack ${pn.id} contains unknown tool "${tn.tool_name}"`,
                );
            }
            for (const tool of resolved) addTool(tool, pn.id, null);
        }
    }

    const wiredSkillNames = new Set<string>();
    const skillSummaries: SimpleHandlerSkill[] = [];
    const addSkill = (name: string) => {
        if (wiredSkillNames.has(name)) return;
        const loaded = deps.skillRegistry.get(name);
        if (!loaded) {
            // Fail at L1 build rather than silently advertising the skill in
            // the system prompt and 404'ing at Skill-tool call time.
            const available = deps.skillRegistry
                .list()
                .map((s) => s.name)
                .sort();
            throw new Error(
                `${ownerLabel}: skill "${name}" is wired but not in the registry. ` +
                    `Available: [${available.join(', ')}]. ` +
                    `Check ~/.fabritorio/skills/ or FABRITORIO_SKILL_ROOTS.`,
            );
        }
        wiredSkillNames.add(name);
        skillSummaries.push({
            name: loaded.name,
            description: loaded.description,
        });
    };

    for (const sn of skillNodes) addSkill(sn.name);

    for (const pn of skillPackNodes) {
        if (!pn.ref_id) continue;
        const l0 = await deps.graphStore.get(pn.ref_id);
        if (!l0) {
            throw new Error(
                `${ownerLabel}: skill_pack ${pn.id} references missing L0 graph ${pn.ref_id}`,
            );
        }
        if (l0.kind !== 'skillpack') {
            throw new Error(
                `${ownerLabel}: skill_pack ${pn.id} references graph ${pn.ref_id} of kind ${l0.kind} (expected skillpack)`,
            );
        }
        const inner = l0.nodes.filter((n): n is SkillNode => n.type === 'skill');
        for (const sn of inner) addSkill(sn.name);
    }

    if (wiredSkillNames.size > 0) {
        const skillTool = createSkillTool(deps.skillRegistry, wiredSkillNames);
        tools.push(skillTool);
        toolNodeIds.set(skillTool.spec.name, handler.id);
    }

    // System prompt as a thunk so markdown-injected sections re-render against
    // the current handles on each Dispatch — agent writes from the previous
    // turn show up on the next prompt without rebuilding the Handler.
    const injectedMemories = opts.injectedMemories ?? [];
    const resolveInjectedHandle =
        opts.resolveInjectedHandle ?? ((_n: MemoryNode) => undefined as MemoryHandle | undefined);
    const systemPrompt: () => string = () =>
        buildSystemPrompt({
            modelSystemPrompt: modelNode.system_prompt,
            skills: skillSummaries,
            injectedMemoryBlock: renderInjectedMemoryBlock(injectedMemories, resolveInjectedHandle),
        });

    // Recursive build: a Router node folds its children (Models or nested
    // Routers) into one synthetic `ModelClient`; a direct Model is the base
    // case. The handler graph only ever sees a single ModelClient, regardless
    // of how deep the router tree is.
    function buildModelClientForNode(node: ModelNode | ModelRouterNode): ModelClient {
        if (node.type === 'model') return deps.modelClientFor(node);
        // Router: gather wired children (priority-sorted) and wrap recursively.
        // The Router emits *out* to its child Models/Routers in the canonical
        // direction — children are the edge *targets*, not sources.
        const childEdges = (l1.edges as Edge[])
            .filter((e) => e.source.node_id === node.id)
            .map((e) => {
                const child = l1.nodes.find((n) => n.id === e.target.node_id);
                return { edge: e, child };
            })
            .filter(
                (
                    x,
                ): x is {
                    edge: Edge;
                    child: ModelNode | ModelRouterNode;
                } =>
                    x.child !== undefined &&
                    (x.child.type === 'model' || x.child.type === 'model_router'),
            );
        if (childEdges.length === 0) {
            throw new Error(`${ownerLabel}: ModelRouter ${node.id} has no Models wired`);
        }
        // Stable sort by priority; undefined sorts last so newly wired
        // children don't bump existing ones down the queue.
        const sorted = childEdges
            .map((x, idx) => ({ ...x, idx }))
            .sort((a, b) => {
                const ap = a.edge.priority;
                const bp = b.edge.priority;
                if (ap === bp) return a.idx - b.idx;
                if (ap === undefined) return 1;
                if (bp === undefined) return -1;
                return ap - bp;
            });
        const children: RouterChild[] = sorted.map(({ child }) => {
            const childClient = buildModelClientForNode(child);
            // For nested routers the `modelId` placeholder surfaces in
            // attempted-event payloads at the *outer* level. The inner
            // router rewrites `req.model` per its own children so the
            // placeholder is never sent to a provider.
            const modelId = child.type === 'model' ? child.model_id : `(router:${child.id})`;
            return { nodeId: child.id, modelId, client: childClient };
        });
        return createRouterClient({
            routerId: node.id,
            children,
            policy: node.policy,
            // No construction-time `emit`: the dispatch's
            // `ctx.emitObservability` is per-call, so `graph-handler.ts`
            // threads a per-call `routerEmit` through `CompleteRequest`
            // that overrides this slot. The synthetic client uses
            // `req.routerEmit ?? opts.emit`, so the construction-time
            // fallback stays available for Step 3's tests.
        });
    }

    const baseNode: ModelNode | ModelRouterNode = directRouter ?? directModel!;
    const modelClient = buildModelClientForNode(baseNode);

    let handlerGraph: Graph | null = null;
    if (handler.ref_id) {
        const loaded = await deps.graphStore.get(handler.ref_id);
        if (!loaded) {
            throw new Error(`${ownerLabel}: handler ref_id ${handler.ref_id} not found`);
        }
        if (loaded.kind !== 'handler') {
            throw new Error(
                `${ownerLabel}: handler ref_id ${handler.ref_id} has kind ${loaded.kind} (expected handler)`,
            );
        }
        handlerGraph = loaded;
    }

    const handlerName = handler.name ?? 'SimpleHandler';
    const handlerInstance = deps.handlerRegistry.build(handlerName, {
        model: modelClient,
        modelId: modelNode.model_id,
        modelNodeId: modelNode.id,
        handlerNodeId: handler.id,
        systemPrompt,
        tools,
        toolNodeIds,
        handlerGraph,
        ...(deps.secretsStore ? { secretsStore: deps.secretsStore } : {}),
        ...(permissionByToolName.size > 0 ? { permissionByToolName } : {}),
        ...(checkpoints.length > 0 ? { checkpoints } : {}),
        config: {
            ...(handler.max_iterations !== undefined
                ? { max_iterations: handler.max_iterations }
                : {}),
            ...(modelNode.temperature !== undefined ? { temperature: modelNode.temperature } : {}),
            ...(modelNode.max_tokens !== undefined ? { max_tokens: modelNode.max_tokens } : {}),
            ...(modelNode.reasoning !== undefined ? { reasoning: modelNode.reasoning } : {}),
        },
    });

    return {
        handler: handlerInstance,
        outputNodeId: output.id,
        handlerNodeId: handler.id,
    };
}

/**
 * Discover every L1 graph this build would dereference (the L0s wired via
 * ToolPack/SkillPack and the saved handler graph). The L2 runtime registry
 * uses this for reload-on-save fan-out.
 */
export async function collectL1Dependencies(l1: Graph): Promise<string[]> {
    const ids: string[] = [];
    for (const inner of l1.nodes) {
        if (
            (inner.type === 'tool_pack' ||
                inner.type === 'skill_pack' ||
                inner.type === 'handler') &&
            typeof inner.ref_id === 'string' &&
            inner.ref_id.length > 0
        ) {
            ids.push(inner.ref_id);
        }
    }
    return ids;
}

function pickOne(l1: Graph, type: NodeType): Node | undefined {
    return l1.nodes.find((n) => n.type === type) as Node | undefined;
}

/**
 * Recursively descend through nested Routers to the priority-0 leaf Model.
 * This is the Model whose config (`model_id`, `node.id`, `system_prompt`,
 * `temperature`, `max_tokens`) flows into the Handler factory — failover
 * children use their own `model_id` at call time via the synthetic router
 * client.
 *
 * "Priority 0" = the wire with the lowest `edge.priority` (undefined sorts
 * last, then stable by edge order). The user's topmost / first-wired child
 * wins.
 *
 * Throws when a Router on the path has zero Models wired — same message
 * shape as the runtime build helper so the bug surfaces once at L1 build
 * regardless of which check fires first.
 */
function resolveHeadlineModel(router: ModelRouterNode, l1: Graph, ownerLabel: string): ModelNode {
    // Router → child direction: walk edges where the Router is the *source*
    // (children sit on the target side). Same flip as `buildModelClientForNode`.
    const childEdges = (l1.edges as Edge[])
        .filter((e) => e.source.node_id === router.id)
        .map((e) => {
            const child = l1.nodes.find((n) => n.id === e.target.node_id);
            return { edge: e, child };
        })
        .filter(
            (
                x,
            ): x is {
                edge: Edge;
                child: ModelNode | ModelRouterNode;
            } =>
                x.child !== undefined &&
                (x.child.type === 'model' || x.child.type === 'model_router'),
        );
    if (childEdges.length === 0) {
        throw new Error(`${ownerLabel}: ModelRouter ${router.id} has no Models wired`);
    }
    const sorted = childEdges
        .map((x, idx) => ({ ...x, idx }))
        .sort((a, b) => {
            const ap = a.edge.priority;
            const bp = b.edge.priority;
            if (ap === bp) return a.idx - b.idx;
            if (ap === undefined) return 1;
            if (bp === undefined) return -1;
            return ap - bp;
        });
    const top = sorted[0]!.child;
    if (top.type === 'model') return top;
    return resolveHeadlineModel(top, l1, ownerLabel);
}

function nodesConnectedTo(l1: Graph, nodeId: string): Node[] {
    const ids = new Set<string>();
    for (const e of l1.edges as Edge[]) {
        if (e.target.node_id === nodeId) ids.add(e.source.node_id);
        if (e.source.node_id === nodeId) ids.add(e.target.node_id);
    }
    return l1.nodes.filter((n) => ids.has(n.id)) as Node[];
}

interface BuiltinToolCtx {
    workspace: WorkspaceBinding | null;
    /**
     * Markdown Memory handle exposed to `memory_read` / `memory_write`. Null
     * when no markdown Memory with `tool_access !== 'none'` is wired — the
     * tools still load (so an unwired user gets a consistent dropdown
     * experience) but every call refuses with a clear message.
     */
    toolMemoryHandle: MemoryHandle | null;
    /**
     * Runner's `GraphStore`, threaded through so cross-graph tools
     * (`list_graphs`, `read_graph`, and the later write tools) can read
     * and mutate the shared store. Always present in production wiring;
     * left as the deps-supplied value so a test that constructs an L1 with
     * no graph-store support still loads the tools (refuses at call time).
     */
    graphStore: GraphStore;
    /**
     * Runner's `GraphRuntimeRegistry`. Required by `create_graph` /
     * `edit_graph` so the persist pipeline can drive the topology-diff +
     * selective reload that the HTTP routes already do. Null in tests that
     * exercise read-only L1 behavior — the write tools still load but refuse
     * at call time.
     */
    runtimes: GraphRuntimeRegistry | null;
    /**
     * Per-Dispatch context shared by built-in tools that need the in-flight
     * Dispatch (`ask_agent`, `prior_turns`, future analogues). Captures the
     * calling agent's L2 outgoing edges + `topicFor` at activate time and
     * exposes a getter for the currently in-flight Dispatch. Null in tests
     * that don't exercise agent coordination — the tools still load but
     * refuse at call time.
     */
    builtinToolBuildCtx: BuiltinToolBuildCtx | null;
    /**
     * The id of the L1 graph this handler was built for. `read_canvas` uses
     * it to walk the store for the parent L2 (the user's "active canvas"
     * — the L2 containing a NativeAgent referencing this L1). Null when the
     * L1 has no id (unsaved / synthetic test L1) — the tool still loads but
     * refuses at call time with a clear message.
     */
    l1GraphId: string | null;
    /**
     * Filesystem registry of user-authored tools. `createBuiltinTool` consults
     * this when a ToolNode names something outside the closed built-in list.
     * Null in tests that don't exercise runtime tools — those L1s only
     * resolve names that match the built-in switch.
     */
    runtimeToolRegistry: RuntimeToolRegistry | null;
}

/**
 * Parse a SecretBinding `source` into a store key. v0 supports `env:NAME`
 * (the value lives under `NAME` in the SecretsStore). An unknown scheme is
 * tolerated — the whole string is treated as the key — but warned once per
 * distinct source so a typo surfaces without spamming the log. NAMES ONLY in
 * the warning; never a value (the store isn't even consulted here).
 */
const warnedSecretSources = new Set<string>();
function parseSecretSource(source: string): string {
    const colon = source.indexOf(':');
    if (colon === -1) {
        // No scheme — treat the whole string as the key (lenient).
        return source;
    }
    const scheme = source.slice(0, colon);
    const rest = source.slice(colon + 1);
    if (scheme === 'env') return rest;
    if (!warnedSecretSources.has(source)) {
        warnedSecretSources.add(source);
        console.warn(
            `[secrets] unknown source scheme in "${source}"; treating the whole string as the store key. Only "env:NAME" is supported in v0.`,
        );
    }
    return source;
}

function createBuiltinTool(
    name: string,
    ctx: BuiltinToolCtx,
    resolveSecretEnv?: () => Record<string, string>,
    config?: Record<string, unknown>,
): Tool | null {
    if (name === 'read_file') return createReadFileTool(ctx.workspace);
    if (name === 'write_file') return createWriteFileTool(ctx.workspace);
    if (name === 'edit_file') return createEditFileTool(ctx.workspace);
    if (name === 'list_directory') return createListDirectoryTool(ctx.workspace);
    if (name === 'bash') return createBashTool(ctx.workspace);
    if (name === 'web_fetch') {
        // `config` shapes the model-facing schema: a pinned `mode`/`selector`
        // is pruned from the tool's `parameters` so the model can't override
        // the design-time choice (see `createWebFetchTool`).
        //
        // Dedup constraint: `addTool` dedupes by `tool.spec.name`, and every
        // `web_fetch` node resolves to spec name `web_fetch` regardless of its config.
        // So two `web_fetch` nodes with different pins both map to `web_fetch` and the
        // SECOND is silently dropped (first-wins). Acceptable for v0 — a handler
        // gets one effective `web_fetch`. Do NOT mint per-config tool names; if this
        // bites later, the fix is a config-derived name suffix, not now.
        return createWebFetchTool(config);
    }
    if (name === 'web_search') {
        // Unlike `web_fetch`, this takes BOTH `config` (the design-time
        // `provider` pin) AND `resolveSecretEnv` (the wired Secret carrying the
        // provider's API key). The tool refuses at call time if the provider is
        // unset or the key isn't wired — see `createWebSearchTool`.
        return createWebSearchTool(config, resolveSecretEnv);
    }
    if (name === 'memory_read') return createMemoryReadTool(ctx.toolMemoryHandle);
    if (name === 'memory_write') return createMemoryWriteTool(ctx.toolMemoryHandle);
    if (name === 'read_canvas') return createReadCanvasTool(ctx.graphStore, ctx.l1GraphId);
    if (name === 'read_graph') return createReadGraphTool(ctx.graphStore);
    if (name === 'create_graph') return createCreateGraphTool(ctx.graphStore, ctx.runtimes);
    if (name === 'edit_graph') return createEditGraphTool(ctx.graphStore, ctx.runtimes);
    if (name === 'instantiate_composite') return createInstantiateCompositeTool(ctx.graphStore);
    if (name === 'ask_agent') {
        // `ask_agent` is expanded upstream into one `ask_agent_<name>` tool per
        // reachable callee (see `resolveAndAddTools` / `createAskAgentTools`).
        // It must never reach the direct resolver — a stray hit here means a
        // loop skipped the fan-out; fail loudly rather than silently minting
        // the old free-form tool.
        throw new Error(
            'ask_agent must be expanded via createAskAgentTools, not createBuiltinTool',
        );
    }
    if (name === 'prior_turns') return createPriorTurnsTool(ctx.builtinToolBuildCtx);
    // Built-in spawning tools (`bash`) are out of scope for v0 secret
    // injection — they inherit `process.env`, which doesn't carry secrets
    // (those live in the scoped store), so they see nothing by default. The
    // `resolveSecretEnv` thunk is threaded only into the runtime-tool
    // (`bash_cli`) path below. See "Out of scope" in `docs/secrets-node.md`.
    if (name === 'get_current_time') return getCurrentTimeTool;
    if (ctx.runtimeToolRegistry) {
        // Retry-after-rescan on miss — mirrors `createSkillTool` (see
        // `runtime/tools.ts`). Makes a fresh CLI build visible without
        // restarting the runner: the model picked the name from `/tools`,
        // the registry just hadn't seen the new dir on its last scan.
        let rt = ctx.runtimeToolRegistry.get(name);
        if (!rt) {
            ctx.runtimeToolRegistry.rescan();
            rt = ctx.runtimeToolRegistry.get(name);
        }
        if (rt) return createRuntimeToolFromManifest(rt, resolveSecretEnv);
    }
    return null;
}
