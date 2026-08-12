#!/bin/bash
set -euo pipefail

BUILT_APP=${1:-$(find src-tauri/target/debug/bundle/macos -maxdepth 1 -name '*.app' -print -quit)}
if [[ -z "$BUILT_APP" ]]; then
  echo "Desktop app bundle was not produced" >&2
  exit 1
fi
BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw -o - "$BUILT_APP/Contents/Info.plist")
APP="/Applications/Zhiye Smoke.app"
[[ ! -e "$APP" ]]
ditto "$BUILT_APP" "$APP"

DATA_DIR="$HOME/Library/Application Support/$BUNDLE_ID"
DATABASE="$DATA_DIR/zhiye.sqlite3"
DEFAULT_DATABASE="$DATABASE"
LAUNCHER_DIR="$HOME/Library/Application Support/$BUNDLE_ID-launcher"
LAUNCHER_CONFIG="$LAUNCHER_DIR/launcher.json"
CUSTOM_DATA_DIR=$(mktemp -d)
FILE_MARKER="$DATA_DIR/.desktop-smoke-files"
INTENT_MARKER="$DATA_DIR/.desktop-smoke-intent"
ERROR_MARKER="$DATA_DIR/.desktop-smoke-error"
LLM_MARKER="$DATA_DIR/.desktop-smoke-llm"
NOTE_DIR=$(mktemp -d)
NOTE="$NOTE_DIR/finder-smoke.md"
COLD_URL="https://example.com/zhiye-cold-smoke"
WARM_URL="https://example.com/zhiye-warm-smoke"
COLD_LINK="zhiye://capture?url=https%3A%2F%2Fexample.com%2Fzhiye-cold-smoke"
WARM_LINK="zhiye://capture?url=https%3A%2F%2Fexample.com%2Fzhiye-warm-smoke"
CUSTOM_URL="https://example.com/zhiye-custom-data-smoke"
CUSTOM_LINK="zhiye://capture?url=https%3A%2F%2Fexample.com%2Fzhiye-custom-data-smoke"
RESTART_URL="https://example.com/zhiye-restart-smoke"
RESTART_LINK="zhiye://capture?url=https%3A%2F%2Fexample.com%2Fzhiye-restart-smoke"
crashed_sidecar_pid=""

quit_app() {
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in {1..10}; do
    pgrep -x zhiye >/dev/null || return 0
    sleep 1
  done
  pkill -x zhiye >/dev/null 2>&1 || true
}

cleanup() {
  quit_app
  if [[ -n "$crashed_sidecar_pid" ]]; then
    sidecar_command=$(ps -p "$crashed_sidecar_pid" -o command= 2>/dev/null || true)
    if [[ "$sidecar_command" == *"$APP/Contents/MacOS/node"* ]]; then
      kill -9 "$crashed_sidecar_pid" >/dev/null 2>&1 || true
    fi
  fi
  launchctl unsetenv ZHIYE_DESKTOP_SMOKE >/dev/null 2>&1 || true
  launchctl unsetenv ZHIYE_KEYCHAIN_SMOKE >/dev/null 2>&1 || true
  rm -rf -- "$NOTE_DIR"
  rm -rf -- "$CUSTOM_DATA_DIR"
  rm -rf -- "$LAUNCHER_DIR"
  rm -rf -- "$APP"
}
trap cleanup EXIT

wait_for_source() {
  local source_url=$1
  for _ in {1..30}; do
    if [[ -f "$DATABASE" ]] && [[ $(sqlite3 "$DATABASE" "SELECT count(*) FROM documents WHERE source_url = '$source_url'") == "1" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for capture: $source_url" >&2
  [[ -f "$INTENT_MARKER" ]] && { echo 'Desktop intent stages:' >&2; cat "$INTENT_MARKER" >&2; }
  [[ -f "$ERROR_MARKER" ]] && { echo 'Desktop startup error:' >&2; cat "$ERROR_MARKER" >&2; }
  ps -axo pid,ppid,command | grep -E 'zhiye|Zhiye Smoke|Contents/MacOS/node' >&2 || true
  find "$DATA_DIR" -maxdepth 1 -type f -print >&2 || true
  return 1
}

quit_app
launchctl setenv ZHIYE_DESKTOP_SMOKE 1
launchctl setenv ZHIYE_KEYCHAIN_SMOKE 1
[[ -x "$APP/Contents/MacOS/zhiye" ]]
rm -f -- "$FILE_MARKER" "$INTENT_MARKER" "$ERROR_MARKER" "$LLM_MARKER"
rm -rf -- "$LAUNCHER_DIR"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
plutil -extract CFBundleURLTypes xml1 -o - "$APP/Contents/Info.plist" | grep -q '<string>zhiye</string>'
open -b "$BUNDLE_ID" "$COLD_LINK"
wait_for_source "$COLD_URL"
grep -Fx 'configured' "$LLM_MARKER" >/dev/null

open -b "$BUNDLE_ID" "$WARM_LINK"
wait_for_source "$WARM_URL"
[[ $(pgrep -x zhiye | wc -l | tr -d ' ') == "1" ]]

before=$(sqlite3 "$DATABASE" 'SELECT count(*) FROM documents')
open -b "$BUNDLE_ID" 'zhiye://delete?url=https%3A%2F%2Fexample.com%2Fmust-not-run'
sleep 2
after=$(sqlite3 "$DATABASE" 'SELECT count(*) FROM documents')
[[ "$before" == "$after" ]]

printf '# Finder smoke\n\nThis file must be handled without starting another app.\n' > "$NOTE"
open -b "$BUNDLE_ID" "$NOTE"
for _ in {1..15}; do
  [[ -f "$FILE_MARKER" ]] && grep -Fx 'finder-smoke.md' "$FILE_MARKER" >/dev/null && break
  sleep 1
done
grep -Fx 'finder-smoke.md' "$FILE_MARKER" >/dev/null
[[ $(pgrep -x zhiye | wc -l | tr -d ' ') == "1" ]]

quit_app
mkdir -m 700 "$LAUNCHER_DIR"
printf '{"version":1,"data_dir":"%s"}' "$CUSTOM_DATA_DIR" > "$LAUNCHER_CONFIG"
chmod 600 "$LAUNCHER_CONFIG"
DATA_DIR="$CUSTOM_DATA_DIR"
DATABASE="$CUSTOM_DATA_DIR/zhiye.sqlite3"
open -b "$BUNDLE_ID" "$CUSTOM_LINK"
wait_for_source "$CUSTOM_URL"
[[ $(sqlite3 "$DEFAULT_DATABASE" "SELECT count(*) FROM documents WHERE source_url = '$CUSTOM_URL'") == "0" ]]
[[ $(pgrep -x zhiye | wc -l | tr -d ' ') == "1" ]]

app_pid=$(pgrep -x zhiye)
crashed_sidecar_pid=$(pgrep -f "$APP/Contents/MacOS/node")
[[ -n "$app_pid" && -n "$crashed_sidecar_pid" ]]
[[ "$crashed_sidecar_pid" != *$'\n'* ]]
kill -9 "$app_pid"
for _ in {1..10}; do
  kill -0 "$crashed_sidecar_pid" >/dev/null 2>&1 || break
  sleep 1
done
if kill -0 "$crashed_sidecar_pid" >/dev/null 2>&1 || pgrep -f "$APP/Contents/MacOS/node" >/dev/null; then
  echo "Tauri SIGKILL left the Node sidecar running" >&2
  exit 1
fi
crashed_sidecar_pid=""
open -b "$BUNDLE_ID" "$RESTART_LINK"
wait_for_source "$RESTART_URL"
[[ $(sqlite3 "$DATABASE" "SELECT count(*) FROM documents WHERE source_url = '$CUSTOM_URL'") == "1" ]]
[[ $(pgrep -x zhiye | wc -l | tr -d ' ') == "1" ]]
