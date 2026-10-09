#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" == Darwin ]]; then
  need_chromium=false
  need_firefox=false
  scoped=false
  explicit_project=false
  project_selected=false
  project_value=false
  file_chromium=false
  file_firefox=false

  mark_project() {
    project_selected=true
    case "$1" in
      all|firefox-scrollbar*) need_chromium=true; need_firefox=true ;;
      chromium*|auth*) need_chromium=true ;;
      firefox*) need_firefox=true ;;
      *) need_chromium=true; need_firefox=true ;;
    esac
  }

  if (($# == 0)); then
    need_chromium=true
    need_firefox=true
  else
    for argument in "$@"; do
      if [[ "$project_value" == true ]]; then
        case "$argument" in
          -*|*.spec.ts) project_value=false ;;
          *) mark_project "$argument"; scoped=true; continue ;;
        esac
      fi
      case "$argument" in
        --project) project_value=true; explicit_project=true; scoped=true ;;
        --project=*) mark_project "${argument#--project=}"; explicit_project=true; scoped=true ;;
        *extension-popup.spec.ts|*extension-x-article.spec.ts|*scrollbar-firefox.spec.ts) file_chromium=true; file_firefox=true; scoped=true ;;
        *auth.setup.ts|*.spec.ts) file_chromium=true; scoped=true ;;
      esac
    done
    if [[ "$explicit_project" == true ]]; then
      if [[ "$project_value" == true || "$project_selected" == false ]]; then need_chromium=true; need_firefox=true; fi
    else
      need_chromium=$file_chromium
      need_firefox=$file_firefox
      if [[ "$scoped" == false ]]; then need_chromium=true; need_firefox=true; fi
    fi
  fi
  for browser in chromium firefox; do
    if [[ "$browser" == chromium && "$need_chromium" == true || "$browser" == firefox && "$need_firefox" == true ]]; then
      if ! pnpm exec node --input-type=module -e "import { ${browser} } from '@playwright/test'; const browser = await ${browser}.launch(); await browser.close();" >/dev/null 2>&1; then
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
