#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

if [[ $(node --version) != v24.19.0 || $(pnpm --version) != 11.7.0 ]]; then
  if [[ ${ZHIYE_SIGN_TOOLCHAIN_BOOTSTRAPPED:-0} != 1 ]] && command -v npm >/dev/null 2>&1; then
    export ZHIYE_SIGN_TOOLCHAIN_BOOTSTRAPPED=1
    exec npm exec --yes --package=node@24.19.0 --package=pnpm@11.7.0 -- bash "$0" "$@"
  fi
  echo "Could not start the locked Node 24.19.0 / pnpm 11.7.0 toolchain." >&2
  exit 1
fi
if [[ -n $(git status --porcelain) ]]; then
  echo "Commit or stash changes before signing so the package matches a source commit." >&2
  exit 1
fi

release_version=$(node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const chrome = JSON.parse(readFileSync("extension/manifest.chrome.json", "utf8"));
const firefox = JSON.parse(readFileSync("extension/manifest.firefox.json", "utf8"));
const signed = JSON.parse(readFileSync("extension/amo/signed-release.json", "utf8"));
if (chrome.version !== firefox.version || firefox.browser_specific_settings?.gecko?.id !== "clipper@zhiye.sarainoq.cn") {
  throw new Error("Chrome/Firefox versions or the AMO ID do not match.");
}
const parts = (version) => {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Invalid extension version.");
  return version.split(".").map(Number);
};
const next = parts(firefox.version);
const previous = parts(signed.version);
const difference = next.findIndex((part, i) => part !== previous[i]);
if (difference < 0 || next[difference] < previous[difference]) {
  throw new Error("This version is already signed or is older than the signed version.");
}
console.log(firefox.version);
JS
)

pnpm install --frozen-lockfile
pnpm firefox:amo

output_dir="${TMPDIR:-/tmp}/zhiye-amo-signed-${release_version}-$(git rev-parse --short=12 HEAD)"
if [[ -e "$output_dir" ]]; then
  echo "Signing output already exists: $output_dir" >&2
  exit 1
fi
if [[ ! -r /dev/tty ]]; then
  echo "Run this script from an interactive Terminal so the AMO credentials stay hidden." >&2
  exit 1
fi
printf '请输入 AMO API Key（输入不回显）: ' > /dev/tty
IFS= read -r -s api_key < /dev/tty
printf '\n请输入 AMO API Secret（输入不回显）: ' > /dev/tty
IFS= read -r -s api_secret < /dev/tty
printf '\n' > /dev/tty
if [[ -z "$api_key" || -z "$api_secret" ]]; then
  echo "Both AMO credentials are required." >&2
  exit 1
fi

mkdir -m 700 "$output_dir"
export WEB_EXT_API_KEY="$api_key" WEB_EXT_API_SECRET="$api_secret"
unset api_key api_secret
trap 'unset WEB_EXT_API_KEY WEB_EXT_API_SECRET' EXIT

npm exec --offline --yes --package=web-ext@10.6.0 -- web-ext sign --channel=unlisted --source-dir "$root/dist/extensions/zhiye-clipper-firefox" --artifacts-dir "$output_dir"

xpis=("$output_dir"/*.xpi)
if [[ ${#xpis[@]} -ne 1 ]]; then
  echo "Expected one signed XPI in $output_dir; inspect the signing output." >&2
  exit 1
fi
xpi=${xpis[0]}
sha256=$(shasum -a 256 "$xpi" | awk '{print $1}')
node scripts/stage-firefox-xpi.mjs "$xpi" "$sha256"

printf 'Signed XPI: %s\nSHA-256: %s\nChrome ZIP: %s\n' "$xpi" "$sha256" "$root/dist/extensions/zhiye-clipper-chrome.zip"
echo "AMO credentials were not saved. Keep the signed XPI outside Git and dist/."
