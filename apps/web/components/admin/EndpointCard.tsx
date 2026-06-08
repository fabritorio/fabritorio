'use client';

import type { ReactNode } from 'react';

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH' | 'SSE';

const methodBadge: Record<Method, string> = {
    GET: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200',
    POST: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
    DELETE: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200',
    PUT: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
    PATCH: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
    SSE: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200',
};

export function EndpointCard({
    method,
    path,
    title,
    description,
    children,
}: {
    method: Method;
    path: string;
    title: string;
    description?: string;
    children: ReactNode;
}) {
    return (
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <header className="mb-3 flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2">
                    <span
                        className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold uppercase ${methodBadge[method]}`}
                    >
                        {method}
                    </span>
                    <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                        {path}
                    </code>
                    <span className="text-sm font-medium text-zinc-900 dark:text-white">
                        {title}
                    </span>
                </div>
            </header>
            {description && (
                <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
            )}
            {children}
        </section>
    );
}

export function ResponseView({
    status,
    statusText,
    durationMs,
    body,
    headers,
    error,
}: {
    status?: number;
    statusText?: string;
    durationMs?: number;
    body?: unknown;
    headers?: Record<string, string>;
    error?: string;
}) {
    if (error) {
        return (
            <pre className="mt-2 max-h-[200px] overflow-auto rounded border border-rose-300 bg-rose-50 p-2 font-mono text-[11px] text-rose-800 dark:border-rose-600/60 dark:bg-rose-950/60 dark:text-rose-200">
                {error}
            </pre>
        );
    }
    if (status === undefined) return null;
    const color =
        status >= 500
            ? 'border-rose-300 dark:border-rose-700'
            : status >= 400
              ? 'border-amber-300 dark:border-amber-700'
              : 'border-emerald-300 dark:border-emerald-700';
    return (
        <div className={`mt-2 rounded border ${color} bg-zinc-50 dark:bg-zinc-950`}>
            <div className="flex items-baseline justify-between border-b border-zinc-200 px-2 py-1 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <span>
                    <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">
                        {status} {statusText}
                    </span>
                    {durationMs !== undefined && <span> · {durationMs}ms</span>}
                </span>
                {headers?.['content-type'] && (
                    <span className="font-mono">{headers['content-type']}</span>
                )}
            </div>
            <pre className="max-h-[240px] overflow-auto p-2 font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                {typeof body === 'string' ? body : JSON.stringify(body, null, 2)}
            </pre>
        </div>
    );
}

export function FieldLabel({ children }: { children: ReactNode }) {
    return (
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {children}
        </label>
    );
}

export function PrimaryButton({
    onClick,
    disabled,
    children,
}: {
    onClick?: () => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
        >
            {children}
        </button>
    );
}

export function DangerButton({
    onClick,
    disabled,
    children,
}: {
    onClick?: () => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="rounded-md bg-rose-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
        >
            {children}
        </button>
    );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
    );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            {...props}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
    );
}
