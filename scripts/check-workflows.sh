#!/bin/bash
set -euo pipefail
# Fixed upstream release and digest; installed only on server/CI, never in source.
if [ -n "${ACTIONLINT:-}" ]; then
  test "$("$ACTIONLINT" -version | head -1 | sed 's/^v//')" = 1.7.12
  exec "$ACTIONLINT" -shellcheck='' .github/workflows/*.yml
fi
tools_dir=$(mktemp -d)
trap 'rm -rf "$tools_dir"' EXIT
curl --fail --silent --show-error --location --retry 2 --retry-all-errors --max-time 120 \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz -o "$tools_dir/actionlint.tar.gz"
echo "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  $tools_dir/actionlint.tar.gz" | sha256sum --check
tar -xzf "$tools_dir/actionlint.tar.gz" -C "$tools_dir" actionlint
"$tools_dir/actionlint" -shellcheck='' .github/workflows/*.yml
