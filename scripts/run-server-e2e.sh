#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" == Darwin ]]; then
  need_chromium=false
  need_firefox=false
  scoped=false
  if (($# == 0)); then
    need_chromium=true
    need_firefox=true
  else
    for argument in "$@"; do
      case "$argument" in
        --project=all) need_chromium=true; need_firefox=true; scoped=true ;;
        --project=firefox*|*extension-popup.spec.ts|*extension-x-article.spec.ts|*scrollbar-firefox.spec.ts) need_firefox=true; scoped=true ;;
        --project=chromium*|*auth.setup.ts|*.spec.ts) need_chromium=true; scoped=true ;;
      esac
    done
    if [[ "$scoped" == false ]]; then need_chromium=true; need_firefox=true; fi
  fi
  for browser in chromium firefox; do
    if [[ "$browser" == chromium && "$need_chromium" == true || "$browser" == firefox && "$need_firefox" == true ]]; then
      executable=$(pnpm exec node --input-type=module -e "import { ${browser} } from '@playwright/test'; process.stdout.write(${browser}.executablePath())")
      if [[ ! -x "$executable" ]]; then
        printf 'Playwright %s is not installed locally; run this check in PR CI or on the Linux developer server. No browser download was started.\n' "$browser" >&2
        exit 2
      fi
    fi
  done
  exec pnpm exec playwright test "$@"
fi

lock=/run/lock/zhiye-e2e.lock
# Provisioned by systemd-tmpfiles as root:zhiye-ci 0660, never replace a live lock.
test -f "$lock" && test -w "$lock"
command -v flock >/dev/null 2>&1 || { printf 'flock is required for Linux server E2E runs.\n' >&2; exit 1; }
exec flock "$lock" pnpm exec playwright test "$@"
