#!/usr/bin/env bash

set -euo pipefail

BROKER_ROOT="${BROWSER_BROKER_HOME:-${HOME}/Library/Application Support/Codex Browser Broker}"
BIN="${BROKER_ROOT}/runtime/bin/interceptor-daemon"
TEMP_ROOT="${BROKER_ROOT}/runtime/interceptor"
PORT="${INTERCEPTOR_WS_PORT:-19422}"
LABEL="com.codex.browser-broker.interceptor"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [ ! -x "$BIN" ]; then
  echo "missing broker daemon: $BIN" >&2
  echo "run: bash scripts/install-browser-broker-runtime.sh" >&2
  exit 2
fi

mkdir -p "$(dirname "$PLIST")" "$TEMP_ROOT"
chmod 700 "$BROKER_ROOT" "$BROKER_ROOT/runtime" "$TEMP_ROOT"
if [ -e "$PLIST" ]; then
  cp -p "$PLIST" "${PLIST}.rollback.${STAMP}"
fi

PLIST_TEMP="${PLIST}.new.$$"
{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0"><dict>'
  printf '%s\n' '  <key>Label</key>' "  <string>${LABEL}</string>"
  printf '%s\n' '  <key>ProgramArguments</key><array>' "    <string>${BIN}</string>" '    <string>--standalone</string>' '  </array>'
  printf '%s\n' '  <key>EnvironmentVariables</key><dict>' "    <key>INTERCEPTOR_TEMP</key><string>${TEMP_ROOT}</string>" "    <key>INTERCEPTOR_WS_PORT</key><string>${PORT}</string>" '  </dict>'
  printf '%s\n' '  <key>RunAtLoad</key><true/>' '  <key>KeepAlive</key><true/>' '  <key>ProcessType</key><string>Background</string>'
  printf '%s\n' "  <key>StandardOutPath</key><string>${TEMP_ROOT}/launchagent.out.log</string>" "  <key>StandardErrorPath</key><string>${TEMP_ROOT}/launchagent.err.log</string>"
  printf '%s\n' '</dict></plist>'
} > "$PLIST_TEMP"
plutil -lint "$PLIST_TEMP" >/dev/null
mv "$PLIST_TEMP" "$PLIST"
chmod 600 "$PLIST"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
launchctl print "$DOMAIN/$LABEL" >/dev/null

printf '%s\n' "broker daemon LaunchAgent installed: $PLIST"
printf '%s\n' "label: $LABEL"
printf '%s\n' "private WebSocket port: $PORT"
printf '%s\n' "Rollback copies, when present: ${PLIST}.rollback.*"
