#!/usr/bin/env bash
# Bind browser automation to one Chrome profile, one extension build, one
# context name, and one stable profile-local extension instance.

set -uo pipefail

MODE="${1:-preflight}"
if [ "$#" -gt 0 ]; then shift; fi

PREFS="${INTERCEPTOR_PROFILE_GUARD_PREFS:-${HOME}/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env}"
if [ ! -f "$PREFS" ]; then
  echo "[ProfileContextGuard] missing preferences: $PREFS" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$PREFS"

PROFILE_NAME="${INTERCEPTOR_TEST_CHROME_PROFILE_NAME:-}"
CONTEXT_ID="${INTERCEPTOR_TEST_CONTEXT_ID:-}"
INSTANCE_ID="${INTERCEPTOR_TEST_CONTEXT_INSTANCE_ID:-}"
EXPECTED_EXTENSION_PATH="${INTERCEPTOR_TEST_EXTENSION_PATH:-}"
EXTENSION_ID="${INTERCEPTOR_EXTENSION_ID:-hkjbaciefhhgekldhncknbjkofbpenng}"
PROFILE_ROOT="${INTERCEPTOR_BROWSER_PROFILE_ROOT:-${HOME}/Library/Application Support/Google/Chrome}"
INTERCEPTOR_BIN="${INTERCEPTOR_BIN:-interceptor}"
OPEN_BIN="${INTERCEPTOR_OPEN_BIN:-/usr/bin/open}"

for required in PROFILE_NAME CONTEXT_ID EXPECTED_EXTENSION_PATH; do
  value="${!required:-}"
  if [ -z "$value" ]; then
    echo "[ProfileContextGuard] $required is not configured in $PREFS" >&2
    exit 2
  fi
done

if ! command -v jq >/dev/null 2>&1; then
  echo "[ProfileContextGuard] jq is required" >&2
  exit 2
fi
if [ ! -x "$INTERCEPTOR_BIN" ] && ! command -v "$INTERCEPTOR_BIN" >/dev/null 2>&1; then
  echo "[ProfileContextGuard] interceptor binary is unavailable: $INTERCEPTOR_BIN" >&2
  exit 2
fi

resolve_profile_directory() {
  local_state="${PROFILE_ROOT}/Local State"
  if [ ! -f "$local_state" ]; then
    echo "[ProfileContextGuard] Chrome profile registry is missing: $local_state" >&2
    return 2
  fi

  profile_matches=()
  while IFS= read -r profile_dir; do
    [ -n "$profile_dir" ] && profile_matches+=("$profile_dir")
  done < <(jq -r --arg name "$PROFILE_NAME" '
    (.profile.info_cache // {})
    | to_entries[]
    | select(.value.name == $name)
    | .key
  ' "$local_state")

  if [ "${#profile_matches[@]}" -ne 1 ]; then
    echo "[ProfileContextGuard] expected exactly one Chrome profile named '$PROFILE_NAME'; found ${#profile_matches[@]}" >&2
    return 7
  fi

  RESOLVED_PROFILE_DIRECTORY="${profile_matches[0]}"
  if [ "$RESOLVED_PROFILE_DIRECTORY" = "Default" ]; then
    echo "[ProfileContextGuard] refusing the Default Chrome profile" >&2
    return 7
  fi

  secure_preferences="${PROFILE_ROOT}/${RESOLVED_PROFILE_DIRECTORY}/Secure Preferences"
  if [ ! -f "$secure_preferences" ]; then
    echo "[ProfileContextGuard] Secure Preferences missing for '$PROFILE_NAME' ($RESOLVED_PROFILE_DIRECTORY)" >&2
    return 7
  fi
  actual_extension_path="$(jq -r --arg id "$EXTENSION_ID" '(.extensions.settings // {})[$id].path // empty' "$secure_preferences")"
  if [ "$actual_extension_path" != "$EXPECTED_EXTENSION_PATH" ]; then
    echo "[ProfileContextGuard] Atlas extension path mismatch" >&2
    echo "  expected: $EXPECTED_EXTENSION_PATH" >&2
    echo "  actual:   ${actual_extension_path:-not installed}" >&2
    return 7
  fi
  return 0
}

preflight() {
  resolve_profile_directory || return $?
  if [ -z "$INSTANCE_ID" ]; then
    echo "[ProfileContextGuard] INTERCEPTOR_TEST_CONTEXT_INSTANCE_ID is not configured; explicit one-time binding is required" >&2
    return 8
  fi

  err_file="$(mktemp -t interceptor-profile-guard.XXXXXX)"
  details_json="$("$INTERCEPTOR_BIN" contexts --details --json 2>"$err_file")"
  command_status=$?
  command_error="$(cat "$err_file")"
  rm -f "$err_file"
  if [ "$command_status" -ne 0 ]; then
    if printf '%s\n' "$command_error" | grep -qiE 'socket exists but this process cannot connect|operation not permitted|permission denied'; then
      echo "[ProfileContextGuard] daemon IPC is blocked inside the execution sandbox; rerun this guarded command outside the execution sandbox" >&2
      [ -n "$command_error" ] && printf '  %s\n' "$command_error" >&2
      return 9
    fi
    echo "[ProfileContextGuard] unable to query live context details" >&2
    [ -n "$command_error" ] && printf '  %s\n' "$command_error" >&2
    return 5
  fi

  matching_contexts="$(printf '%s' "$details_json" | jq -c --arg context "$CONTEXT_ID" '[.[] | select(.kind == "browser" and .contextId == $context)]')" || {
    echo "[ProfileContextGuard] invalid context-details response" >&2
    return 5
  }
  match_count="$(printf '%s' "$matching_contexts" | jq 'length')"
  if [ "$match_count" -ne 1 ]; then
    echo "[ProfileContextGuard] required browser context '$CONTEXT_ID' is not uniquely connected (found $match_count)" >&2
    return 5
  fi

  live_instance="$(printf '%s' "$matching_contexts" | jq -r '.[0].instanceId // empty')"
  if [ "$live_instance" != "$INSTANCE_ID" ]; then
    echo "[ProfileContextGuard] context instance mismatch for '$CONTEXT_ID'" >&2
    echo "  expected Atlas instance: $INSTANCE_ID" >&2
    echo "  connected instance:      ${live_instance:-missing}" >&2
    return 6
  fi

  printf 'READY profile="%s" directory="%s" context="%s" instance="%s"\n' \
    "$PROFILE_NAME" "$RESOLVED_PROFILE_DIRECTORY" "$CONTEXT_ID" "$INSTANCE_ID"
  return 0
}

ensure_profile() {
  preflight
  status=$?
  if [ "$status" -eq 0 ]; then return 0; fi
  if [ "$status" -ne 5 ]; then return "$status"; fi

  resolve_profile_directory || return $?
  "$OPEN_BIN" -a "Google Chrome" --args \
    --profile-directory="$RESOLVED_PROFILE_DIRECTORY" \
    --new-window \
    about:blank || return 5

  attempt=1
  while [ "$attempt" -le 18 ]; do
    sleep 1
    if preflight; then
      return 0
    fi
    attempt=$((attempt + 1))
  done
  echo "[ProfileContextGuard] '$PROFILE_NAME' opened but its verified context did not attach within 18 seconds" >&2
  return 5
}

run_guarded() {
  for arg in "$@"; do
    case "$arg" in
      --context|--context=*|--any-tab|--activate)
        echo "[ProfileContextGuard] caller may not override the verified context or background-first boundary: $arg" >&2
        return 7
        ;;
    esac
  done
  preflight || return $?
  exec "$INTERCEPTOR_BIN" --context "$CONTEXT_ID" "$@"
}

case "$MODE" in
  resolve)
    resolve_profile_directory || exit $?
    printf '%s\n' "$RESOLVED_PROFILE_DIRECTORY"
    ;;
  preflight)
    preflight
    exit $?
    ;;
  ensure)
    ensure_profile
    exit $?
    ;;
  run)
    run_guarded "$@"
    ;;
  *)
    echo "Usage: $0 resolve|preflight|ensure|run <interceptor arguments>" >&2
    exit 2
    ;;
esac
