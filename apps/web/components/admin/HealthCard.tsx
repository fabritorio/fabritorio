'use client';

import { useCallback, useState } from 'react';
import { createRunnerClient } from '@/lib/runner-client';
import { EndpointCard, PrimaryButton, ResponseView } from './EndpointCard';

export function HealthCard() {
    const [state, setState] = useState<{
        status?: number;
        body?: unknown;
        durationMs?: number;
        error?: string;
    }>({});

    const onSend = useCallback(async () => {
        setState({});
        const client = createRunnerClient();
        try {
            const res = await client.rawFetch('GET', '/health');
            setState({
                status: res.status,
                body: res.body,
                durationMs: res.durationMs,
            });
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
        }
    }, []);

    return (
        <EndpointCard
            method="GET"
            path="/health"
            title="Runner health"
            description="Liveness probe; returns runner version."
        >
            <PrimaryButton onClick={onSend}>Send</PrimaryButton>
            <ResponseView {...state} />
        </EndpointCard>
    );
}
