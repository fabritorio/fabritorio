'use client';

import { useTheme } from '@/lib/theme';

export function ThemeToggle() {
    const { theme, toggle } = useTheme();
    const isDark = theme === 'dark';
    return (
        <button
            type="button"
            onClick={toggle}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Light mode' : 'Dark mode'}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
            <span aria-hidden>{isDark ? '☀' : '☾'}</span>
        </button>
    );
}
