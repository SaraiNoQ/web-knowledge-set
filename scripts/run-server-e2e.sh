#!/bin/bash
set -euo pipefail
lock=/run/lock/zhiye-e2e.lock
# Provisioned by systemd-tmpfiles as root:zhiye-ci 0660, never replace a live lock.
test -f "$lock" && test -w "$lock"
exec flock "$lock" pnpm exec playwright test "$@"
