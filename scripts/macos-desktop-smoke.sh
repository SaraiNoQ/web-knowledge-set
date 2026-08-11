#!/bin/bash
set -euo pipefail

BUILT_APP=$(find src-tauri/target/debug/bundle/macos -maxdepth 1 -name '*.app' -print -quit)
if [[ -z "$BUILT_APP" ]]; then
  echo "Desktop app bundle was not produced" >&2
  exit 1
fi
APP="/Applications/Zhiye Smoke.app"
[[ ! -e "$APP" ]]
ditto "$BUILT_APP" "$APP"

DATA_DIR="$HOME/Library/Application Support/dev.local.zhiye"
DATABASE="$DATA_DIR/zhiye.sqlite3"
FILE_MARKER="$DATA_DIR/.desktop-smoke-files"
INTENT_MARKER="$DATA_DIR/.desktop-smoke-intent"
ERROR_MARKER="$DATA_DIR/.desktop-smoke-error"
NOTE_DIR=$(mktemp -d)
NOTE="$NOTE_DIR/finder-smoke.md"
COLD_URL="https://example.com/zhiye-cold-smoke"
WARM_URL="https://example.com/zhiye-warm-smoke"
COLD_LINK="zhiye://capture?url=https%3A%2F%2Fexample.com%2Fzhiye-cold-smoke"
WARM_LINK="zhiye://capture?url=https%3A%2F%2Fexample.com%2Fzhiye-warm-smoke"

quit_app() {
  osascript -e 'tell application id "dev.local.zhiye" to quit' >/dev/null 2>&1 || true
  for _ in {1..10}; do
    pgrep -x zhiye >/dev/null || return 0
    sleep 1
  done
  pkill -x zhiye >/dev/null 2>&1 || true
}

cleanup() {
  quit_app
  launchctl unsetenv ZHIYE_DESKTOP_SMOKE >/dev/null 2>&1 || true
  rm -rf -- "$NOTE_DIR"
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
rm -f -- "$FILE_MARKER" "$INTENT_MARKER" "$ERROR_MARKER"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
plutil -extract CFBundleURLTypes xml1 -o - "$APP/Contents/Info.plist" | grep -q '<string>zhiye</string>'
open -b dev.local.zhiye "$COLD_LINK"
wait_for_source "$COLD_URL"

open -b dev.local.zhiye "$WARM_LINK"
wait_for_source "$WARM_URL"
[[ $(pgrep -x zhiye | wc -l | tr -d ' ') == "1" ]]

before=$(sqlite3 "$DATABASE" 'SELECT count(*) FROM documents')
open -b dev.local.zhiye 'zhiye://delete?url=https%3A%2F%2Fexample.com%2Fmust-not-run'
sleep 2
after=$(sqlite3 "$DATABASE" 'SELECT count(*) FROM documents')
[[ "$before" == "$after" ]]

printf '# Finder smoke\n\nThis file must be handled without starting another app.\n' > "$NOTE"
open -b dev.local.zhiye "$NOTE"
for _ in {1..15}; do
  [[ -f "$FILE_MARKER" ]] && grep -Fx 'finder-smoke.md' "$FILE_MARKER" >/dev/null && break
  sleep 1
done
grep -Fx 'finder-smoke.md' "$FILE_MARKER" >/dev/null
[[ $(pgrep -x zhiye | wc -l | tr -d ' ') == "1" ]]
