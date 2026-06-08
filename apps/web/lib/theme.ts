'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'fabritorio:theme';

function readInitialTheme(): Theme {
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
        return 'dark';
    }
    return 'light';
}

function applyTheme(theme: Theme): void {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        /* ignore */
    }
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
    const [theme, setThemeState] = useState<Theme>('light');

    useEffect(() => {
        setThemeState(readInitialTheme());
    }, []);

    const setTheme = useCallback((t: Theme) => {
        applyTheme(t);
        setThemeState(t);
    }, []);

    const toggle = useCallback(() => {
        setTheme(theme === 'dark' ? 'light' : 'dark');
    }, [theme, setTheme]);

    return { theme, toggle, setTheme };
}
