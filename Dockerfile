# syntax=docker/dockerfile:1

# ---- Stage 1: build the flattened package ----
FROM node:24-bookworm AS builder
WORKDIR /src
RUN corepack enable             # packageManager pins pnpm@9.15.0; corepack picks it up
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:package          # scripts/build-package.mjs → dist-pkg/ (bin/ dist/ web/ seed-skills/)

# ---- Stage 2: runtime (Node + Go + bash/git for the bash tool & tool-builder) ----
FROM node:24-bookworm-slim AS runtime
ARG GO_VERSION=1.23.4
ARG TARGETARCH                  # set by buildkit: amd64 | arm64
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl bash \
    && rm -rf /var/lib/apt/lists/*
# Go toolchain — runtime dep (tool-builder compiles in-container)
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
      | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH

# State + caches live under one volume via HOME relocation. os.homedir() returns
# $HOME on Linux, so ~/.fabritorio (token, secrets, conversations, graphs, …)
# lands under /data. HOST/PORT are read straight from env by the bundled server
# (apps/runner/src/config.ts) — see CMD note on why we bypass the launcher.
ENV HOME=/data \
    GOMODCACHE=/data/.cache/go/mod \
    GOCACHE=/data/.cache/go/build \
    HOST=0.0.0.0 \
    PORT=4000 \
    FAB_WEB_DIR=/app/web \
    FAB_SEED_SKILLS_DIR=/app/seed-skills
RUN mkdir -p /data && chown -R node:node /data

COPY --from=builder --chown=node:node /src/dist-pkg /app
USER node
WORKDIR /app
EXPOSE 4000
VOLUME ["/data"]
# Run the bundled server directly, NOT bin/fabritorio.js: the launcher forces
# HOST=127.0.0.1 (and deletes $HOST from the env), so behind it the bind is
# loopback-only and unreachable through the published port. dist/server.js
# honours HOST/PORT from the env; FAB_WEB_DIR / FAB_SEED_SKILLS_DIR (set above)
# replace what the launcher would otherwise inject for the flattened tree.
CMD ["node", "dist/server.js"]
