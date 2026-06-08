import type { NextConfig } from 'next';

// Static-export ONLY for the packaged/same-origin build. `next build` sets
// NEXT_OUTPUT_EXPORT=1 (see apps/web/package.json) → `output: 'export'` emits
// apps/web/out/. `next dev` leaves it unset → normal dev server, so dynamic
// routes like /graphs/<id> resolve at runtime instead of 500-ing under export's
// dynamicParams=false constraint (which only knows the `_` placeholder).
const isExport = process.env.NEXT_OUTPUT_EXPORT === '1';

const nextConfig: NextConfig = {
    output: isExport ? 'export' : undefined,
    transpilePackages: ['@fabritorio/types'],
    reactStrictMode: true,
    // Dev-only SPA fallback for deep graph links. The packaged build serves the
    // static export and the Fastify SPA fallback returns index.html for
    // /graphs/<id>; `next dev` has no such fallback, and the export pin
    // (dynamicParams=false, which only knows the `_` placeholder) would 404 a
    // hard load / refresh of a real id. Rewrite real ids to the `_` template so
    // dev answers 200 with the app shell — the browser path stays /graphs/<id>
    // (rewrites are internal) and GraphRoute reads the real id off it. The key
    // is omitted entirely under export (rewrites are unsupported there, and
    // defining it — even returning [] — trips Next's export-no-custom-routes
    // warning).
    ...(isExport
        ? {}
        : {
              async rewrites() {
                  return [{ source: '/graphs/:id', destination: '/graphs/_' }];
              },
          }),
};

export default nextConfig;
