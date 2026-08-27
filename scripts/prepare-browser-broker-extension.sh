#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROKER_ROOT="${BROWSER_BROKER_HOME:-${HOME}/Library/Application Support/Codex Browser Broker}"
TARGET="${BROKER_ROOT}/extension"
PORT="${INTERCEPTOR_WS_PORT:-19422}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

case "$PORT" in
  ''|*[!0-9]*) echo "INTERCEPTOR_WS_PORT must be numeric" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "INTERCEPTOR_WS_PORT must be between 1024 and 65535" >&2
  exit 2
fi
if [ ! -f "$ROOT/extension/dist/background.js" ]; then
  echo "missing extension build; run: bash scripts/build.sh --browser-only" >&2
  exit 2
fi

mkdir -p "$BROKER_ROOT"
chmod 700 "$BROKER_ROOT"
if [ -e "$TARGET" ]; then
  mv "$TARGET" "${TARGET}.rollback.${STAMP}"
fi
cp -R "$ROOT/extension/dist" "$TARGET"

perl -pi -e "s/ws:\/\/localhost:19222/ws:\/\/localhost:${PORT}/g" "$TARGET/background.js"

if rg -q "localhost:19222" "$TARGET/background.js"; then
  echo "broker extension still contains the default Interceptor port" >&2
  exit 1
fi
if ! rg -q "localhost:${PORT}" "$TARGET/background.js"; then
  echo "broker extension does not contain the configured port" >&2
  exit 1
fi

printf '%s\n' "broker extension prepared: $TARGET"
printf '%s\n' "WebSocket port: $PORT"
printf '%s\n' "Rollback copies, when present: ${TARGET}.rollback.*"
