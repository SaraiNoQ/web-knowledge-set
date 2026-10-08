#!/bin/bash
set -euo pipefail
request_path=${1:?Pass private request file}
stage=starting
finish() {
  result=$?
  if ! RELEASE_STAGE="$stage" RELEASE_EXIT_CODE="$result" node scripts/record-release-exit.mjs "$request_path"; then result=1; fi
  rm -f "$request_path" || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
node scripts/record-release-exit.mjs "$request_path"
test "$(node --version)" = v24.19.0
test "$(pnpm --version)" = 11.7.0
test "$(id -u)" != 0
exec 9>/srv/zhiye-delivery/production.lock
flock -x 9

# Only immutable main source reaches this account. No production token is exported to builds.
stage=install
pnpm install --frozen-lockfile
stage=policy
node scripts/check-delivery.mjs
stage=production-plan
node scripts/cloudflare-delivery.mjs plan "$request_path"
full_validation=$(node -e 'try { console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).fullValidation === true ? "true" : "false"); } catch { process.exit(1); }' "$request_path")
if [ "$full_validation" = true ]; then
  stage=full-release-types
  pnpm check
  stage=full-release-audit
  pnpm audit --registry=https://registry.npmjs.org --audit-level high
  stage=full-release-browsers
  pnpm exec playwright install chromium firefox --only-shell
  stage=full-release-unit-integration
  node --test tests/delivery-policy.test.mjs tests/cloudflare-delivery.test.mjs
  pnpm test
fi
# A production build creates required publishable assets; routine releases reuse CI tests.
stage=build
pnpm build
if [ "$full_validation" = true ]; then
  stage=full-release-notices
  pnpm notices:check
  stage=full-release-e2e
  bash scripts/run-server-e2e.sh
  stage=full-release-extension
  pnpm firefox:amo
  pnpm cloud:bundle
fi
stage=firefox-signature
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const release = JSON.parse(readFileSync('extension/amo/signed-release.json'));
const manifest = JSON.parse(readFileSync('extension/manifest.firefox.json'));
assert.equal(release.version, manifest.version, 'Update the reviewed AMO signed-release record');
assert(/^[a-zA-Z0-9._-]+\.xpi$/.test(release.filename));
execFileSync(process.execPath, ['scripts/stage-firefox-xpi.mjs', `/srv/zhiye-delivery/signed/${release.filename}`, release.sha256], { stdio: 'inherit' });
JS
stage=production-config-dry-run
# Also validate the actual production configuration; example dry-runs cannot prove it.
pnpm exec wrangler deploy --dry-run --config cloud/wrangler.web.jsonc
pnpm exec wrangler deploy --dry-run --config cloud/wrangler.clip.jsonc
stage=publish
node scripts/cloudflare-delivery.mjs publish "$request_path"
