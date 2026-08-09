#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
exec rsync -az --delete-delay \
  --exclude .git \
  --exclude .DS_Store \
  --exclude '.env*' \
  --exclude .secrets \
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
  ./ root@campus-server:/root/dev/zhiye/
