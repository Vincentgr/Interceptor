#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROKER_ROOT="${BROWSER_BROKER_HOME:-${HOME}/Library/Application Support/Codex Browser Broker}"
BIN_DIR="${BROKER_ROOT}/runtime/bin"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

for source in "$ROOT/dist/interceptor" "$ROOT/daemon/interceptor-daemon" "$ROOT/scripts/profile-context-guard.sh"; do
  if [ ! -f "$source" ]; then
    echo "missing browser-only build artifact: $source" >&2
    echo "run: bash scripts/build.sh --browser-only" >&2
    exit 2
  fi
done

mkdir -p "$BIN_DIR"
chmod 700 "$BROKER_ROOT" "$BROKER_ROOT/runtime" "$BIN_DIR"

for name in interceptor interceptor-daemon profile-context-guard.sh; do
  target="$BIN_DIR/$name"
  if [ -e "$target" ]; then
    cp -p "$target" "${target}.rollback.${STAMP}"
  fi
done

install -m 0755 "$ROOT/dist/interceptor" "$BIN_DIR/interceptor"
install -m 0755 "$ROOT/daemon/interceptor-daemon" "$BIN_DIR/interceptor-daemon"
install -m 0755 "$ROOT/scripts/profile-context-guard.sh" "$BIN_DIR/profile-context-guard.sh"

"$BIN_DIR/interceptor" --version >/dev/null
printf '%s\n' "broker Interceptor runtime installed: $BIN_DIR"
printf '%s\n' "Rollback copies, when present: $BIN_DIR/*.rollback.*"
