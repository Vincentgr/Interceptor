#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_ROOT="${BROWSER_BROKER_INSTALL_ROOT:-${HOME}/.local}"
BIN_DIR="${INSTALL_ROOT}/bin"
SHARE_DIR="${INSTALL_ROOT}/share/codex-browser-broker"
TARGET="${BIN_DIR}/browser-broker"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BIN_DIR" "$SHARE_DIR"

if [ -e "$TARGET" ]; then
  cp -p "$TARGET" "${TARGET}.rollback.${STAMP}"
fi

cd "$ROOT"
bun run build:browser-broker
install -m 0755 "$ROOT/dist/browser-broker" "$TARGET"

if [ ! -x "$SHARE_DIR/node_modules/.bin/playwright-cli" ]; then
  npm install --prefix "$SHARE_DIR" --no-save --no-audit --no-fund @playwright/cli@0.1.18
fi

"$TARGET" help >/dev/null
"$SHARE_DIR/node_modules/.bin/playwright-cli" --help >/dev/null

printf '%s\n' "browser-broker installed: $TARGET"
printf '%s\n' "Playwright CLI installed: $SHARE_DIR/node_modules/.bin/playwright-cli"
printf '%s\n' "Rollback copies, when present: ${TARGET}.rollback.*"
