import type React from 'react';
import { useState } from 'react';

export function Label({ children }: { children: React.ReactNode }) {
    return (
        <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {children}
        </label>
    );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
    );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            {...props}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
    );
}

export function HeaderRow({ label, id }: { label: string; id: string }) {
    return (
        <div className="rounded-md bg-zinc-100 px-2 py-1 text-[11px] dark:bg-zinc-950">
            <span className="font-medium text-zinc-600 dark:text-zinc-400">{label}</span>{' '}
            <span className="font-mono text-zinc-500 dark:text-zinc-500">{id}</span>
        </div>
    );
}

export function parseOptionalNumber(raw: string): number | undefined {
    if (raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function parseIntList(raw: string): number[] {
    return raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
}

export function IntListInput({
    value,
    onCommit,
    placeholder,
}: {
    value: number[];
    onCommit: (next: number[]) => void;
    placeholder?: string;
}) {
    const [draft, setDraft] = useState(value.join(', '));
    return (
        <Input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => {
                setDraft(e.target.value);
                onCommit(parseIntList(e.target.value));
            }}
            onBlur={() => setDraft(parseIntList(draft).join(', '))}
        />
    );
}
