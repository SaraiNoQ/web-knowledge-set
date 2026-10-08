#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
destination_host=${1:-root@campus-server}
destination_directory=${2:?Pass an absolute isolated task mirror directory}
case "$destination_host" in *[!a-zA-Z0-9@._-]*|'') echo "Invalid SSH destination" >&2; exit 1;; esac
case "$destination_directory" in /*) ;; *) echo "Use an absolute isolated mirror path" >&2; exit 1;; esac
case "$destination_directory" in *[!a-zA-Z0-9/_-]*|/) echo "Unsafe mirror path" >&2; exit 1;; esac
case "$destination_directory" in
  /root/dev/zhiye-?*|/srv/zhiye-delivery/runs/?*/source) ;;
  *) echo "Mirror must be a task directory under /root/dev/zhiye-* or production runs/*/source" >&2; exit 1;;
esac
exec rsync -az --delete-delay \
  --exclude .git \
  --exclude .DS_Store \
  --exclude '.env*' \
  --exclude .secrets \
  --exclude .wrangler \
  --exclude .cache \
  --exclude .codegraph \
  --exclude .codex \
  --exclude .agents \
  --exclude target \
  --exclude backup \
  --exclude backup-backups \
  --exclude backup-diagnostics \
  --exclude .backup.zhiye.lock \
  --exclude node_modules \
  --exclude .pnpm-store \
  --exclude dist \
  --exclude dist-server \
  --exclude desktop-resources \
  --exclude src-tauri/target \
  --exclude src-tauri/binaries \
  --exclude playwright-report \
  --exclude test-results \
  --exclude .data \
  ./ "$destination_host:$destination_directory/"
