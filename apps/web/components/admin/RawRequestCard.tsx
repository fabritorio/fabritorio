'use client';

import { useCallback, useState } from 'react';
import { createRunnerClient } from '@/lib/runner-client';
import {
    EndpointCard,
    FieldLabel,
    PrimaryButton,
    ResponseView,
    TextArea,
    TextInput,
} from './EndpointCard';

const methods = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'] as const;

export function RawRequestCard() {
    const [method, setMethod] = useState<(typeof methods)[number]>('GET');
    const [path, setPath] = useState('/graphs');
    const [body, setBody] = useState('');
    const [state, setState] = useState<{
        status?: number;
        statusText?: string;
        body?: unknown;
        headers?: Record<string, string>;
        durationMs?: number;
        error?: string;
    }>({});

    const onSend = useCallback(async () => {
        setState({});
        let parsed: unknown = undefined;
        if (body.trim()) {
            try {
                parsed = JSON.parse(body);
            } catch (err) {
                setState({
                    error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
                });
                return;
            }
        }
        try {
            const res = await createRunnerClient().rawFetch(method, path, parsed);
            setState({
                status: res.status,
                statusText: res.statusText,
                body: res.body,
                headers: res.headers,
                durationMs: res.durationMs,
            });
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
        }
    }, [body, method, path]);

    return (
        <EndpointCard
            method="GET"
            path="(any)"
            title="Raw request"
            description="Send any method + path + body. Useful for probing the 501-stub endpoints or exploring error cases."
        >
            <div className="grid grid-cols-[100px_1fr] gap-2">
                <div>
                    <FieldLabel>Method</FieldLabel>
                    <select
                        value={method}
                        onChange={(e) => setMethod(e.target.value as (typeof methods)[number])}
                        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    >
                        {methods.map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <FieldLabel>Path</FieldLabel>
                    <TextInput
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        placeholder="/graphs"
                    />
                </div>
            </div>
            <div className="mt-3">
                <FieldLabel>Body (JSON, leave blank for none)</FieldLabel>
                <TextArea
                    rows={5}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    spellCheck={false}
                    placeholder="{}"
                />
            </div>
            <div className="mt-2">
                <PrimaryButton onClick={onSend}>Send</PrimaryButton>
            </div>
            <ResponseView {...state} />
        </EndpointCard>
    );
}
