#!/usr/bin/env bash
# Free the runner's port before `tsx watch` binds it.
#
# `tsx watch` restarts by killing its node child and spawning a fresh one that
# re-binds the port. On a bulk file change (e.g. `git checkout` rewriting many
# watched files at once) the restarts can overlap and the dying child gets
# orphaned still holding the socket, so the next bind fails with EADDRINUSE and
# the dev server wedges. This clears any stale listener at session start so a
# fresh `pnpm dev` always comes up clean — automating the manual
# `lsof -ti tcp:4000 | xargs kill`. Best-effort: a no-op when nothing is
# listening. Honors PORT (default 4000). macOS/Linux (needs `lsof`).
set -uo pipefail
PORT="${PORT:-4000}"
pids="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [ -n "$pids" ]; then
    echo "freeport: killing stale listener(s) on :${PORT} -> ${pids//$'\n'/ }" >&2
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
fi
exit 0
