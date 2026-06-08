#!/usr/bin/env bash
set -euo pipefail

# DEV-ONLY. Binds the runner to HOST=0.0.0.0, exposing it (including the bash
# tool) to the whole LAN. This is a convenience for testing on a phone/tablet on
# a trusted home network — NOT a deployment mode. Security model (see
# docs/install-and-security.md §5.3):
#   - The runner still requires the per-install token (X-Fabritorio-Token) on
#     every mutating route, and
#   - the Host-header allowlist 403s any request whose Host isn't loopback. This
#     script exports FAB_ALLOWED_HOSTS=<LAN IP> below so the LAN host passes;
#     without it every LAN request is rejected.
# Do not expose this to an untrusted network.

# Detect LAN IP — try common macOS interfaces, then fall back to a generic scan.
IP=""
for iface in en0 en1 en2 en3; do
    candidate=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    if [ -n "$candidate" ]; then
        IP="$candidate"
        break
    fi
done

if [ -z "$IP" ]; then
    IP=$(ifconfig 2>/dev/null \
        | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}' \
        || true)
fi

if [ -z "$IP" ]; then
    echo "dev-lan: could not detect LAN IP — set HOST/CORS_ORIGIN/NEXT_PUBLIC_RUNNER_URL manually and run 'pnpm turbo run dev:lan'" >&2
    exit 1
fi

export HOST=0.0.0.0
export CORS_ORIGIN="http://${IP}:3000"
export NEXT_PUBLIC_RUNNER_URL="http://${IP}:4000"
# Let the LAN host through the Host-header allowlist (§5.1) — without this the
# runner 403s every request that arrives with Host: <LAN IP>:4000.
export FAB_ALLOWED_HOSTS="${IP}"

echo "dev-lan: web=http://${IP}:3000  runner=http://${IP}:4000"
exec pnpm turbo run dev:lan
