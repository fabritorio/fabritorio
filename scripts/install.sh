#!/bin/sh
# Fabritorio one-shot installer — served from https://fabritorio.dev/install.sh.
# Convenience front door for:   curl -fsSL https://fabritorio.dev/install.sh | sh
# It is a thin wrapper, NOT a separate distribution channel: it just checks for
# Node >= 24, installs the npm package globally, then launches it. Everything it
# installs is the same `fabritorio` package you'd get from `npm i -g fabritorio`.
set -e

REQUIRED_MAJOR=24

err() {
    echo "fabritorio: $1" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || err \
    "Node.js >= ${REQUIRED_MAJOR} is required but 'node' was not found. Install it from https://nodejs.org/ and re-run."

# node -v prints like "v24.14.0"; strip the leading v and take the major.
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
case "$NODE_MAJOR" in
    '' | *[!0-9]*) err "could not parse Node version from '$(node -v)'." ;;
esac
if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
    err "Node.js >= ${REQUIRED_MAJOR} is required, but $(node -v) is installed. Upgrade from https://nodejs.org/ and re-run."
fi

command -v npm >/dev/null 2>&1 || err "'npm' was not found (it ships with Node.js). Reinstall Node from https://nodejs.org/."

echo "Installing fabritorio globally (npm i -g fabritorio)..."
npm install -g fabritorio

echo "Launching fabritorio..."
exec fabritorio
