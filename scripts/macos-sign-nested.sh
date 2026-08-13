#!/bin/bash
set -euo pipefail

[[ ${ZHIYE_SIGN_RELEASE:-} == 1 ]] || exit 0
[[ $(uname -s) == Darwin ]] || { echo "Release signing requires macOS" >&2; exit 1; }
: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}"

ENTITLEMENTS="src-tauri/entitlements.chromium.plist"
plutil -lint "$ENTITLEMENTS" >/dev/null

sign_path() {
  local path=$1
  local -a args=(--force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY")
  [[ "$path" == *node-aarch64-apple-darwin || "$(basename "$path")" == chrome-headless-shell ]] && args+=(--entitlements "$ENTITLEMENTS")
  codesign "${args[@]}" "$path"
}

for root in desktop-resources/runtime/browsers; do
  [[ -e "$root" ]] || { echo "Missing nested release code: $root" >&2; exit 1; }
  while IFS= read -r -d '' path; do
    if [[ -f "$path" ]] && file -b "$path" | grep -q 'Mach-O'; then
      sign_path "$path"
    elif [[ -d "$path" && "$path" =~ \.(app|framework|xpc)$ ]]; then
      sign_path "$path"
    fi
  done < <(find "$root" -depth -print0)
done
