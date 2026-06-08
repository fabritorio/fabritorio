'use client';

import { ThemeToggle } from '../ThemeToggle';
import Link from 'next/link';
import { HealthCard } from './HealthCard';
import { RawRequestCard } from './RawRequestCard';

export function AdminDashboard() {
    return (
        <div className="flex h-screen w-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-baseline gap-4">
                    <Link
                        href="/"
                        className="text-sm font-semibold tracking-wide text-zinc-900 transition hover:text-indigo-700 dark:text-white dark:hover:text-indigo-300"
                    >
                        Fabritorio
                    </Link>
                    <span className="text-xs text-zinc-500 dark:text-zinc-500">
                        admin · raw runner access
                    </span>
                </div>
                <ThemeToggle />
            </header>
            <main className="flex-1 overflow-auto p-4">
                <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-2">
                    <HealthCard />
                    <div className="md:col-span-2">
                        <RawRequestCard />
                    </div>
                </div>
            </main>
        </div>
    );
}
