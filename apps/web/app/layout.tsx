import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
    title: 'Fabritorio',
    description: 'Local-first visual environment for composing AI agents',
};

const themeInit = `(() => {
  try {
    const stored = localStorage.getItem("fabritorio:theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = stored === "dark" || (stored !== "light" && prefersDark);
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: themeInit }} />
            </head>
            <body className="h-screen w-screen overflow-hidden">{children}</body>
        </html>
    );
}
