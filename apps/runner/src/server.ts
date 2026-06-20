import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createGraphStore, type GraphStore } from './graphs/store.js';
import { migrateAgentSidecars, migrateDuplicateRefs } from './graphs/migrate.js';
import { registerGraphRoutes } from './routes/graphs.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerTriggerRoutes } from './routes/triggers.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerDispatchesRoutes } from './routes/dispatches.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerDebugRoutes } from './routes/debug.js';
import { registerDebugProbeRoutes } from './routes/debug-probe.js';
import { registerPermissionRoutes } from './routes/permission.js';
import { registerPaletteRoutes } from './routes/palette.js';
import { createEventBus, type EventBus } from './runtime/event-bus.js';
import type { EventLog } from './runtime/event-log.js';
import {
    createGraphRuntimeRegistry,
    createNodeRegistry,
    type GraphRuntimeRegistry,
    type NodeRegistry,
} from './runtime/graph-runtime.js';
import { createChannelRegistry, type ChannelRegistry } from './runtime/channels.js';
import { createWebchatBinding } from './runtime/bindings/webchat.js';
import { createNativeAgentBinding } from './runtime/bindings/native-agent.js';
import { createMemoryBinding } from './runtime/bindings/memory.js';
import { createTriggerBinding } from './runtime/bindings/trigger.js';
import { createDebugGatewayBinding } from './runtime/bindings/debug-gateway.js';
import { awaitProbesFor, createDebugProbeBinding } from './runtime/bindings/debug-probe.js';
import { createPermissionBinding } from './runtime/bindings/permission.js';
import { createDebugGatewayRegistry, type DebugGatewayRegistry } from './runtime/debug.js';
import { createDebugProbeRegistry, type DebugProbeRegistry } from './runtime/debug-probe.js';
import { createPermissionGateRegistry, type PermissionGateRegistry } from './runtime/permission.js';
import {
    createDispatchAbortRegistry,
    type DispatchAbortRegistry,
} from './runtime/dispatch-aborts.js';
import {
    createTriggerStrategyRegistry,
    type TriggerStrategyRegistry,
} from './runtime/triggers/strategy.js';
import {
    createCronStrategyFactory,
    createCronerScheduler,
    createIntervalScheduler,
    type IntervalScheduler,
    type Scheduler,
} from './runtime/triggers/cron.js';
import { createScheduleStrategyFactory } from './runtime/triggers/schedule.js';
import { createDefaultToolRegistry, type ToolRegistry } from './runtime/tools.js';
import { createRuntimeToolRegistry, type RuntimeToolRegistry } from './runtime/runtime-tools.js';
import { createSecretsStore, type SecretsStore } from './runtime/secrets-store.js';
import { createSkillRegistry, type SkillRegistry } from './runtime/skills.js';
import { createMemoryRegistry, resolveMemoryDir, type MemoryRegistry } from './runtime/memory.js';
import { loadOrMintToken } from './runtime/token.js';
import {
    registerHostAllowlist,
    registerTokenCheck,
    parseAllowedHosts,
} from './runtime/security-hooks.js';
import {
    createConversationLabelStore,
    type ConversationLabelStore,
} from './runtime/conversation-labels.js';
import type { ModelClient } from './runtime/model.js';
import { defaultModelClientFor } from './runtime/providers/registry.js';
import { createDefaultHandlerRegistry, type HandlerRegistry } from './runtime/handlers/registry.js';
import { seedDefaultHandlerGraph } from './runtime/handlers/default-graph.js';
import { seedForemanLibraryGraphs } from './runtime/handlers/foreman-seeds.js';
import { seedSkills } from './runtime/handlers/skill-seeds.js';
import { seedStarterLibraryGraphs } from './runtime/handlers/starter-seeds.js';
import type { ModelNode } from '@fabritorio/types';

declare module 'fastify' {
    interface FastifyInstance {
        graphStore: GraphStore;
        runtimes: GraphRuntimeRegistry;
        bootstrapComplete: Promise<void>;
        fabToken: string;
    }
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')) as {
    version: string;
};

const DEFAULT_DEV_ORIGIN = 'http://localhost:3000';

export interface ServerOptions {
    logger?: boolean;
    graphStore?: GraphStore;
    bus?: EventBus;
    runtimes?: GraphRuntimeRegistry;
    nodes?: NodeRegistry;
    channels?: ChannelRegistry;
    memoryRegistry?: MemoryRegistry;
    conversationLabels?: ConversationLabelStore;
    debugGatewayRegistry?: DebugGatewayRegistry;
    debugProbeRegistry?: DebugProbeRegistry;
    permissionGateRegistry?: PermissionGateRegistry;
    dispatchAborts?: DispatchAbortRegistry;
    toolRegistry?: ToolRegistry;
    skillRegistry?: SkillRegistry;
    runtimeToolRegistry?: RuntimeToolRegistry;
    secretsStore?: SecretsStore;
    handlerRegistry?: HandlerRegistry;
    triggerStrategies?: TriggerStrategyRegistry;
    cronScheduler?: Scheduler;
    intervalScheduler?: IntervalScheduler;
    modelClientFor?: (node: ModelNode) => ModelClient;
    eventLog?: EventLog;
    memoryDir?: string;
    conversationsDir?: string;
    corsOrigin?: string | string[] | false;
    token?: string;
}

function createDefaultTriggerStrategies(
    scheduler: Scheduler,
    intervalScheduler: IntervalScheduler,
): TriggerStrategyRegistry {
    const reg = createTriggerStrategyRegistry();
    reg.register('cron', createCronStrategyFactory({ scheduler }));
    reg.register('schedule', createScheduleStrategyFactory({ scheduler, intervalScheduler }));
    return reg;
}

function createDefaultNodeRegistry(deps: {
    channels: ChannelRegistry;
    graphStore: GraphStore;
    skillRegistry: SkillRegistry;
    runtimeToolRegistry: RuntimeToolRegistry;
    secretsStore: SecretsStore;
    memoryRegistry: MemoryRegistry;
    debugGatewayRegistry: DebugGatewayRegistry;
    debugProbeRegistry: DebugProbeRegistry;
    permissionGateRegistry: PermissionGateRegistry;
    dispatchAborts: DispatchAbortRegistry;
    modelClientFor: (node: ModelNode) => ModelClient;
    handlerRegistry: HandlerRegistry;
    triggerStrategies: TriggerStrategyRegistry;
    runtimesRef: () => GraphRuntimeRegistry | undefined;
}): NodeRegistry {
    const reg = createNodeRegistry();
    reg.register('channel', createWebchatBinding(deps.channels));
    reg.register('trigger', createTriggerBinding({ strategies: deps.triggerStrategies }));
    reg.register('memory', createMemoryBinding({ registry: deps.memoryRegistry }));
    reg.register(
        'native_agent',
        createNativeAgentBinding({
            graphStore: deps.graphStore,
            skillRegistry: deps.skillRegistry,
            runtimeToolRegistry: deps.runtimeToolRegistry,
            secretsStore: deps.secretsStore,
            memoryRegistry: deps.memoryRegistry,
            modelClientFor: deps.modelClientFor,
            handlerRegistry: deps.handlerRegistry,
            permissionGateRegistry: deps.permissionGateRegistry,
            dispatchAborts: deps.dispatchAborts,
            runtimesRef: deps.runtimesRef,
        }),
    );
    const { binding: debugBinding } = createDebugGatewayBinding({
        graphStore: deps.graphStore,
        skillRegistry: deps.skillRegistry,
        runtimeToolRegistry: deps.runtimeToolRegistry,
        secretsStore: deps.secretsStore,
        modelClientFor: deps.modelClientFor,
        handlerRegistry: deps.handlerRegistry,
        memoryRegistry: deps.memoryRegistry,
        registry: deps.debugGatewayRegistry,
        permissionGateRegistry: deps.permissionGateRegistry,
        dispatchAborts: deps.dispatchAborts,
        runtimesRef: deps.runtimesRef,
    });
    reg.register('debug_gateway', debugBinding);
    const { binding: probeBinding } = createDebugProbeBinding({
        registry: deps.debugProbeRegistry,
    });
    reg.register('debug_probe', probeBinding);
    const { binding: permissionBinding } = createPermissionBinding({
        registry: deps.permissionGateRegistry,
    });
    reg.register('permission', permissionBinding);
    return reg;
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
    const app = Fastify({ logger: opts.logger ?? true, forceCloseConnections: true });
    const bus = opts.bus ?? createEventBus();
    const graphStore = opts.graphStore ?? createGraphStore();
    const channels = opts.channels ?? createChannelRegistry();
    const skillRegistry = opts.skillRegistry ?? createSkillRegistry();
    const runtimeToolRegistry = opts.runtimeToolRegistry ?? createRuntimeToolRegistry();
    const secretsStore = opts.secretsStore ?? createSecretsStore();
    const memoryRegistry =
        opts.memoryRegistry ??
        createMemoryRegistry(opts.memoryDir ? { localStorageDir: opts.memoryDir } : {});
    const conversationLabels =
        opts.conversationLabels ?? createConversationLabelStore({ dir: opts.conversationsDir });
    const debugGatewayRegistry = opts.debugGatewayRegistry ?? createDebugGatewayRegistry();
    const debugProbeRegistry = opts.debugProbeRegistry ?? createDebugProbeRegistry();
    const permissionGateRegistry = opts.permissionGateRegistry ?? createPermissionGateRegistry();
    const dispatchAborts = opts.dispatchAborts ?? createDispatchAbortRegistry();
    const modelClientFor = opts.modelClientFor ?? defaultModelClientFor;
    const handlerRegistry = opts.handlerRegistry ?? createDefaultHandlerRegistry();
    const triggerStrategies =
        opts.triggerStrategies ??
        createDefaultTriggerStrategies(
            opts.cronScheduler ?? createCronerScheduler(),
            opts.intervalScheduler ?? createIntervalScheduler(),
        );
    let runtimesValue: GraphRuntimeRegistry | undefined;
    const runtimesRef = () => runtimesValue;

    const nodes =
        opts.nodes ??
        createDefaultNodeRegistry({
            channels,
            graphStore,
            skillRegistry,
            runtimeToolRegistry,
            secretsStore,
            memoryRegistry,
            debugGatewayRegistry,
            debugProbeRegistry,
            permissionGateRegistry,
            dispatchAborts,
            modelClientFor,
            handlerRegistry,
            triggerStrategies,
            runtimesRef,
        });
    const runtimes =
        opts.runtimes ??
        createGraphRuntimeRegistry({
            bus,
            nodes,
            getGraph: (id) => graphStore.get(id),
            awaitProbe: (args) => awaitProbesFor(debugProbeRegistry.forGraph(args.graphId), args),
        });
    runtimesValue = runtimes;

    if (opts.eventLog) {
        const log = opts.eventLog;
        bus.subscribeDispatch((event) => {
            void log.appendDispatch(event).catch((err) => {
                app.log.error({ err }, 'event log append (dispatch) failed');
            });
        });
        bus.subscribeObservability((event) => {
            void log.appendObservability(event).catch((err) => {
                app.log.error({ err }, 'event log append (observability) failed');
            });
        });
    }

    void (opts.toolRegistry ?? createDefaultToolRegistry());

    const corsOrigin = opts.corsOrigin ?? process.env.CORS_ORIGIN ?? DEFAULT_DEV_ORIGIN;
    if (corsOrigin !== false) {
        app.register(cors, { origin: corsOrigin });
    }

    registerHostAllowlist(app, parseAllowedHosts(process.env.FAB_ALLOWED_HOSTS));

    const token = opts.token ?? loadOrMintToken();

    const seedDefaultHandlerDone = seedDefaultHandlerGraph(graphStore).catch((err) => {
        app.log.error({ err }, 'default handler graph seed failed');
    });

    const seedForemanDone = seedForemanLibraryGraphs(graphStore).catch((err) => {
        app.log.error({ err }, 'foreman library seed failed');
    });

    try {
        const seeded = seedSkills();
        if (seeded.length > 0) {
            skillRegistry.rescan();
            app.log.info({ seeded }, 'system skills seeded');
        }
    } catch (err) {
        app.log.error({ err }, 'system skill seed failed');
    }

    const seedStarterDone = seedStarterLibraryGraphs(graphStore).catch((err) => {
        app.log.error({ err }, 'starter library seed failed');
    });

    const migrateDone = migrateDuplicateRefs(graphStore, {
        log: (line) => app.log.info(line),
    })
        .then(() =>
            migrateAgentSidecars(graphStore, {
                log: (line) => app.log.info(line),
            }),
        )
        .catch((err) => {
            app.log.error({ err }, 'composite-by-value / sidecar migration failed');
        });

    const bootstrapComplete = Promise.allSettled([
        seedDefaultHandlerDone,
        seedForemanDone,
        seedStarterDone,
        migrateDone,
    ]).then(() => undefined);

    app.addHook('onClose', async () => {
        await bootstrapComplete;
    });

    app.register(
        async (api) => {
            registerTokenCheck(api, token);

            api.get('/health', async () => ({ ok: true, version: pkg.version }));
            api.get('/bootstrap', async () => ({ token, version: pkg.version }));
            registerGraphRoutes(api, { graphStore, runtimes, conversationLabels });
            registerChannelRoutes(api, { channels, bus, runtimes });
            registerTriggerRoutes(api, { runtimes, bus });
            registerAgentRoutes(api, {
                runtimes,
                bus,
                eventLog: opts.eventLog,
                conversationLabels,
            });
            registerDispatchesRoutes(api, { dispatchAborts });
            registerObservabilityRoutes(api, { bus });
            registerStreamRoutes(api, {
                bus,
                runtimes,
                permissionRegistry: permissionGateRegistry,
            });
            registerDebugRoutes(api, { registry: debugGatewayRegistry, bus });
            registerDebugProbeRoutes(api, { registry: debugProbeRegistry });
            registerPermissionRoutes(api, { registry: permissionGateRegistry });
            registerMemoryRoutes(api, {
                memory: memoryRegistry,
                memoryDir: resolveMemoryDir(opts.memoryDir),
            });
            registerToolRoutes(api, { runtimeToolRegistry });
            registerSkillRoutes(api, { skillRegistry });
            registerPaletteRoutes(api);
        },
        { prefix: '/api' },
    );

    const webDir = process.env.FAB_WEB_DIR ?? resolve(here, '..', '..', 'web', 'out');
    if (existsSync(webDir)) {
        app.log.info({ webDir }, 'serving web export (same-origin)');
        app.register(fastifyStatic, { root: webDir });
        app.setNotFoundHandler((req, reply) => {
            const accept = req.headers.accept ?? '';
            if (req.method !== 'GET' || !accept.includes('text/html')) {
                return reply.code(404).send({ error: 'not_found' });
            }
            const pathname = (req.url.split('?')[0] ?? '/').replace(/\/+$/, '');
            const segments = pathname.split('/').filter(Boolean);
            if (segments.length > 0 && !segments.includes('..')) {
                const direct = `${segments.join('/')}.html`;
                if (existsSync(resolve(webDir, direct))) return reply.sendFile(direct);
                const dynamic = `${[...segments.slice(0, -1), '_'].join('/')}.html`;
                if (existsSync(resolve(webDir, dynamic))) return reply.sendFile(dynamic);
            }
            return reply.sendFile('index.html');
        });
    } else {
        app.log.info({ webDir }, 'web export not found — skipping static (split dev)');
    }

    app.decorate('graphStore', graphStore);
    app.decorate('runtimes', runtimes);
    app.decorate('bootstrapComplete', bootstrapComplete);
    app.decorate('fabToken', token);

    return app;
}
