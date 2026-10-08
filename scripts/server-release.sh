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
node --test tests/delivery-policy.test.mjs tests/cloudflare-delivery.test.mjs
stage=production-plan
node scripts/cloudflare-delivery.mjs plan "$request_path"
stage=type-check
pnpm check
stage=unit-integration
pnpm test
stage=build
pnpm build
stage=cloud-check
pnpm cloud:check
stage=notices
pnpm notices:check
stage=browser-install
pnpm exec playwright install chromium firefox --only-shell
stage=browser-tests
bash scripts/run-server-e2e.sh
stage=firefox-signature
pnpm firefox:amo
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
pnpm cloud:bundle
stage=production-config-dry-run
# Also validate the actual production configuration; example dry-runs cannot prove it.
pnpm exec wrangler deploy --dry-run --config cloud/wrangler.web.jsonc
pnpm exec wrangler deploy --dry-run --config cloud/wrangler.clip.jsonc
stage=publish
node scripts/cloudflare-delivery.mjs publish "$request_path"
