#!/bin/sh
set -eu

APP_ROOT=/opt/zhiye-preview
RELEASES=$APP_ROOT/releases
CURRENT=$APP_ROOT/current
DATA_ROOT=/var/lib/zhiye-preview
SERVICE=zhiye-preview.service
USER=zhiye-preview
activation_pending=0
activation_previous=
activation_was_active=0
activation_was_enabled=0
activation_next=
activation_rollback=
ready_cookie=
ready_json=

usage() {
  echo "usage: $0 stage <40-char-sha> [source-root] | activate <40-char-sha> | rollback <40-char-sha> | status" >&2
  exit 2
}

require_root() {
  [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
}

valid_sha() {
  case "$1" in *[!0-9a-f]*|'') return 1 ;; esac
  [ "${#1}" -eq 40 ]
}

ensure_layout() {
  if ! id "$USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin "$USER"
  fi
  user_id=$(id -u "$USER")
  for directory in "$APP_ROOT" "$RELEASES"; do
    if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then mkdir -m 0755 "$directory"; fi
    [ "$(stat -c '%F:%u:%a' -- "$directory" 2>/dev/null)" = "directory:0:755" ] || {
      echo "unsafe deployment directory: $directory" >&2
      exit 1
    }
  done
  if [ ! -e "$DATA_ROOT" ] && [ ! -L "$DATA_ROOT" ]; then
    mkdir -m 0700 "$DATA_ROOT"
    chown "$USER:$USER" "$DATA_ROOT"
  fi
  [ "$(stat -c '%F:%u:%a' -- "$DATA_ROOT" 2>/dev/null)" = "directory:$user_id:700" ] || {
    echo "unsafe data root: $DATA_ROOT" >&2
    exit 1
  }
  if [ ! -e "$DATA_ROOT/data" ] && [ ! -L "$DATA_ROOT/data" ]; then
    runuser -u "$USER" -- mkdir -m 0700 "$DATA_ROOT/data"
  fi
  [ "$(stat -c '%F:%u:%a' -- "$DATA_ROOT/data" 2>/dev/null)" = "directory:$user_id:700" ] || {
    echo "unsafe data directory: $DATA_ROOT/data" >&2
    exit 1
  }
}

cleanup_ready_files() {
  [ -z "$ready_cookie" ] || unlink -- "$ready_cookie" 2>/dev/null || true
  [ -z "$ready_json" ] || unlink -- "$ready_json" 2>/dev/null || true
  ready_cookie=
  ready_json=
}

service_ready() {
  pid=$(systemctl show --property MainPID --value "$SERVICE")
  if ! systemctl is-active --quiet "$SERVICE" ||
    [ "${pid:-0}" -le 0 ] ||
    [ "$(stat -c %u "/proc/$pid" 2>/dev/null || echo -1)" -ne "$(id -u "$USER")" ]; then
    return 1
  fi
  ready_cookie=$(mktemp /run/zhiye-preview-ready.XXXXXX) || return 1
  ready_json=$(mktemp /run/zhiye-preview-status.XXXXXX) || { cleanup_ready_files; return 1; }
  if ! /usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      --cookie-jar "$ready_cookie" \
      http://127.0.0.1:4301/ >/dev/null ||
    ! /usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      --cookie "$ready_cookie" --output "$ready_json" \
      http://127.0.0.1:4301/api/data-safety ||
    ! "$CURRENT/node" -e '
      try {
        const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        const health = value.health;
        const valid = value.mode === "ready" && value.maintenance === false && health &&
          health.database.integrityCheck.length === 1 && health.database.integrityCheck[0] === "ok" &&
          health.database.foreignKeyViolations.length === 0 &&
          health.missingSnapshots.length === 0 && health.missingAssets.length === 0 &&
          health.unsafeSnapshotEntries.length === 0 && health.unsafeAssetEntries.length === 0;
        if (!valid) process.exitCode = 1;
      } catch { process.exitCode = 1; }
    ' "$ready_json"; then
    cleanup_ready_files
    return 1
  fi
  cleanup_ready_files
  return 0
}

wait_ready() {
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    service_ready && return 0
    sleep 1
  done
  return 1
}

rollback_activation() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$activation_pending" -eq 1 ] || exit "$status"
  activation_pending=0
  [ "$status" -ne 0 ] || status=1
  set +e
  cleanup_ready_files
  systemctl stop "$SERVICE"
  [ -z "$activation_next" ] || unlink -- "$activation_next" 2>/dev/null
  [ -z "$activation_rollback" ] || unlink -- "$activation_rollback" 2>/dev/null
  if [ -n "$activation_previous" ]; then
    activation_rollback=$APP_ROOT/.current-rollback-$$
    ln -s "$activation_previous" "$activation_rollback" && mv -Tf "$activation_rollback" "$CURRENT"
  elif [ -L "$CURRENT" ]; then
    unlink "$CURRENT"
  fi
  if [ "$activation_was_enabled" -eq 1 ]; then
    systemctl enable "$SERVICE" >/dev/null
  else
    systemctl disable "$SERVICE" >/dev/null
  fi
  if [ "$activation_was_active" -eq 1 ]; then
    if systemctl restart "$SERVICE" && wait_ready; then
      echo "activation failed; previous release restored" >&2
    else
      echo "activation failed and previous release failed health verification" >&2
    fi
  else
    echo "activation failed; previous stopped state restored" >&2
  fi
  exit "$status"
}

activate() {
  sha=$1
  valid_sha "$sha" || usage
  target=$RELEASES/$sha
  [ -x "$target/node" ] && [ -f "$target/dist-server/server/index.js" ] && [ -d "$target/browsers" ] || {
    echo "release is incomplete: $target" >&2
    exit 1
  }
  activation_previous=
  if [ -L "$CURRENT" ]; then
    activation_previous=$(readlink -f "$CURRENT")
    case "$activation_previous" in "$RELEASES"/*) ;; *) echo "current points outside releases" >&2; exit 1 ;; esac
  elif [ -e "$CURRENT" ]; then
    echo "current is not a symbolic link" >&2
    exit 1
  fi
  activation_was_active=0
  activation_was_enabled=0
  systemctl is-active --quiet "$SERVICE" && activation_was_active=1
  systemctl is-enabled --quiet "$SERVICE" && activation_was_enabled=1
  activation_pending=1
  trap rollback_activation EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  systemctl stop "$SERVICE"
  if ss -H -ltn 'sport = :4301' | grep -q .; then
    echo "port 4301 is occupied outside $SERVICE; stop that process explicitly" >&2
    exit 1
  fi
  systemctl enable "$SERVICE" >/dev/null
  activation_next=$APP_ROOT/.current-next-$$
  ln -s "$target" "$activation_next"
  mv -Tf "$activation_next" "$CURRENT"
  activation_next=
  if ! systemctl restart "$SERVICE" || ! wait_ready; then
    systemctl --no-pager --full status "$SERVICE" >&2 || true
    return 1
  fi
  activation_pending=0
  trap - EXIT HUP INT TERM
  cleanup_ready_files
  echo "active release: $sha"
}

require_root
command=${1:-}
case "$command" in
  stage)
    sha=${2:-}
    valid_sha "$sha" || usage
    source_root=$(cd "${3:-.}" && pwd -P)
    runtime=$source_root/desktop-resources/runtime
    [ -f "$runtime/dist-server/server/index.js" ] && [ -d "$runtime/browsers" ] || {
      echo "run pnpm desktop:prepare before staging" >&2
      exit 1
    }
    set -- "$source_root"/src-tauri/binaries/node-*
    [ "$#" -eq 1 ] && [ -x "$1" ] || { echo "expected one prepared Node binary" >&2; exit 1; }
    ensure_layout
    target=$RELEASES/$sha
    [ ! -e "$target" ] || { echo "release already exists: $target" >&2; exit 1; }
    staging=$RELEASES/.stage-$sha-$$
    [ ! -e "$staging" ] || { echo "staging path already exists" >&2; exit 1; }
    trap 'if [ -n "${staging:-}" ] && [ -d "$staging" ]; then rm -rf -- "$staging"; fi' EXIT HUP INT TERM
    install -d -m 0755 "$staging"
    cp -a "$runtime"/. "$staging"/
    install -m 0755 "$1" "$staging/node"
    install -m 0644 "$source_root/scripts/smoke-browser-capture.mjs" "$staging/smoke-browser-capture.mjs"
    printf '%s\n' "$sha" > "$staging/RELEASE_SHA"
    chown -R root:root "$staging"
    runuser -u "$USER" -- env \
      HOME="$DATA_ROOT" \
      PLAYWRIGHT_BROWSERS_PATH="$staging/browsers" \
      "$staging/node" "$staging/smoke-browser-capture.mjs" "$staging"
    mv "$staging" "$target"
    staging=
    install -m 0644 "$source_root/scripts/zhiye-preview.service" "/etc/systemd/system/$SERVICE"
    systemctl daemon-reload
    trap - EXIT HUP INT TERM
    echo "staged release: $sha"
    ;;
  activate|rollback)
    ensure_layout
    activate "${2:-}"
    ;;
  status)
    printf 'current: '
    readlink -f "$CURRENT" 2>/dev/null || echo "not installed"
    systemctl --no-pager --full status "$SERVICE"
    ;;
  *) usage ;;
esac
