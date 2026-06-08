import {
    ModelInvocationError,
    type CompleteChunk,
    type CompleteRequest,
    type ModelClient,
} from '../model.js';

export interface RouterChild {
    nodeId: string;
    modelId: string;
    client: ModelClient;
}

export type RouterEvent =
    | {
          type: 'model_router.attempted';
          routerId: string;
          modelNodeId: string;
          modelId: string;
          attempt: number;
      }
    | {
          type: 'model_router.fell_through';
          routerId: string;
          fromModelNodeId: string;
          fromModelId: string;
          toModelNodeId: string;
          toModelId: string;
          reason: string;
      };

export interface CreateRouterClientOptions {
    routerId: string;
    children: RouterChild[];
    policy: 'failover';
    emit?: (event: RouterEvent) => void;
}

export function shouldFallThrough(err: unknown): boolean {
    return classifyError(err).fallThrough;
}

interface Classification {
    fallThrough: boolean;
    reason: string;
}

const FALL_THROUGH_STATUSES = new Set([401, 403, 429, 502, 503, 504]);
const PROPAGATE_STATUSES = new Set([400, 404, 422]);

const STATUS_LABELS: Record<number, string> = {
    401: '401 Unauthorized',
    403: '403 Forbidden',
    429: '429 Too Many Requests',
    502: '502 Bad Gateway',
    503: '503 Service Unavailable',
    504: '504 Gateway Timeout',
};

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
]);

function readNumber(obj: unknown, key: string): number | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'number' ? v : undefined;
}

function readString(obj: unknown, key: string): string | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
}

function extractStatus(err: unknown): number | undefined {
    let cur: unknown = err;
    for (let i = 0; i < 5 && cur; i++) {
        const direct = readNumber(cur, 'status');
        if (direct !== undefined) return direct;
        const response = (cur as { response?: unknown }).response;
        const fromResponse = readNumber(response, 'status');
        if (fromResponse !== undefined) return fromResponse;
        cur = (cur as { cause?: unknown }).cause;
    }
    return undefined;
}

function extractNetworkCode(err: unknown): string | undefined {
    let cur: unknown = err;
    for (let i = 0; i < 5 && cur; i++) {
        const code = readString(cur, 'code');
        if (code && NETWORK_CODES.has(code)) return code;
        cur = (cur as { cause?: unknown }).cause;
    }
    return undefined;
}

function extractMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return 'unknown error';
}

function statusFromMessage(message: string): number | undefined {
    const m = /\b(4\d{2}|5\d{2})\b/.exec(message);
    return m ? Number(m[1]) : undefined;
}

function networkCodeFromMessage(message: string): string | undefined {
    for (const code of NETWORK_CODES) {
        if (message.includes(code)) return code;
    }
    return undefined;
}

export function classifyError(err: unknown): Classification {
    const status = extractStatus(err);
    if (status !== undefined) {
        if (FALL_THROUGH_STATUSES.has(status)) {
            return { fallThrough: true, reason: STATUS_LABELS[status] ?? `${status}` };
        }
        if (PROPAGATE_STATUSES.has(status)) {
            return { fallThrough: false, reason: `${status}` };
        }
        if (status >= 500 && status < 600) {
            return { fallThrough: true, reason: `${status}` };
        }
        return { fallThrough: false, reason: `${status}` };
    }

    const networkCode = extractNetworkCode(err);
    if (networkCode) {
        return { fallThrough: true, reason: networkCode };
    }

    const message = extractMessage(err);
    const statusInMessage = statusFromMessage(message);
    if (statusInMessage !== undefined) {
        if (FALL_THROUGH_STATUSES.has(statusInMessage)) {
            return {
                fallThrough: true,
                reason: STATUS_LABELS[statusInMessage] ?? `${statusInMessage}`,
            };
        }
        if (PROPAGATE_STATUSES.has(statusInMessage)) {
            return { fallThrough: false, reason: `${statusInMessage}` };
        }
        if (statusInMessage >= 500 && statusInMessage < 600) {
            return { fallThrough: true, reason: `${statusInMessage}` };
        }
    }
    const networkInMessage = networkCodeFromMessage(message);
    if (networkInMessage) {
        return { fallThrough: true, reason: networkInMessage };
    }

    if (/\b(fetch failed|network|socket hang up|aborted)\b/i.test(message)) {
        return { fallThrough: true, reason: 'network error' };
    }

    return { fallThrough: false, reason: message };
}

export function createRouterClient(opts: CreateRouterClientOptions): ModelClient {
    if (opts.policy !== 'failover') {
        throw new Error(`model_router policy "${String(opts.policy)}" not implemented`);
    }
    if (opts.children.length === 0) {
        throw new Error(`model_router "${opts.routerId}" has no children`);
    }

    const { routerId, children } = opts;

    return {
        async *complete(req: CompleteRequest): AsyncIterable<CompleteChunk> {
            const emit = req.routerEmit ?? opts.emit;
            const failures: Array<{ child: RouterChild; reason: string }> = [];

            for (let i = 0; i < children.length; i++) {
                const child = children[i]!;
                emit?.({
                    type: 'model_router.attempted',
                    routerId,
                    modelNodeId: child.nodeId,
                    modelId: child.modelId,
                    attempt: i,
                });

                const childReq: CompleteRequest = { ...req, model: child.modelId };

                const iter = child.client.complete(childReq)[Symbol.asyncIterator]();
                let first: IteratorResult<CompleteChunk>;
                try {
                    first = await iter.next();
                } catch (err) {
                    const cls = classifyError(err);
                    if (!cls.fallThrough) {
                        throw err;
                    }
                    failures.push({ child, reason: cls.reason });
                    const next = children[i + 1];
                    if (next) {
                        emit?.({
                            type: 'model_router.fell_through',
                            routerId,
                            fromModelNodeId: child.nodeId,
                            fromModelId: child.modelId,
                            toModelNodeId: next.nodeId,
                            toModelId: next.modelId,
                            reason: cls.reason,
                        });
                    }
                    continue;
                }

                if (first.done) {
                    return;
                }

                yield first.value;
                let next = await iter.next();
                while (!next.done) {
                    yield next.value;
                    next = await iter.next();
                }
                return;
            }

            const summary = failures
                .map((f) => `${f.child.nodeId} (${f.child.modelId}): ${f.reason}`)
                .join('; ');
            throw new ModelInvocationError(
                `model_router "${routerId}" exhausted all ${failures.length} children: ${summary}`,
            );
        },
    };
}
