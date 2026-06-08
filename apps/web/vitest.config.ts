import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Next.js maps `@/*` → `./*` (see tsconfig.json `paths`). Mirror it here so
    // tests can import components that use the alias transitively without each
    // test file having to switch to relative paths.
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
        },
    },
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        setupFiles: ['test/setup.ts'],
    },
});
