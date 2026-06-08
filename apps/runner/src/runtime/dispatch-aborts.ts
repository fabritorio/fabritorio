export interface DispatchAbortRegistry {
    mint(eventId: string, parentId?: string): AbortController;
    get(eventId: string): AbortController | undefined;
    abort(eventId: string): boolean;
    release(eventId: string): void;
}

export function createDispatchAbortRegistry(): DispatchAbortRegistry {
    const controllers = new Map<string, AbortController>();
    const parentLinks = new Map<string, { parentSignal: AbortSignal; listener: () => void }>();
    return {
        mint(eventId: string, parentId?: string): AbortController {
            const controller = new AbortController();
            controllers.set(eventId, controller);
            if (parentId !== undefined) {
                const parent = controllers.get(parentId);
                if (parent) {
                    const parentSignal = parent.signal;
                    const listener = () => controller.abort();
                    if (parentSignal.aborted) {
                        controller.abort();
                    } else {
                        parentSignal.addEventListener('abort', listener, { once: true });
                        parentLinks.set(eventId, { parentSignal, listener });
                    }
                }
            }
            return controller;
        },
        get(eventId: string): AbortController | undefined {
            return controllers.get(eventId);
        },
        abort(eventId: string): boolean {
            const controller = controllers.get(eventId);
            if (!controller) return false;
            controller.abort();
            return true;
        },
        release(eventId: string): void {
            controllers.delete(eventId);
            const link = parentLinks.get(eventId);
            if (link) {
                link.parentSignal.removeEventListener('abort', link.listener);
                parentLinks.delete(eventId);
            }
        },
    };
}
