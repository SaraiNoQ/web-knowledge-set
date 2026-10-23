#!/bin/bash
set -euo pipefail

APP=${1:?Usage: package-macos-installer.sh /path/to/织页.app /path/to/output.pkg}
OUTPUT=${2:?An output .pkg path is required}
INFO="$APP/Contents/Info.plist"
IDENTIFIER=$(plutil -extract CFBundleIdentifier raw -o - "$INFO")
VERSION=$(plutil -extract CFBundleShortVersionString raw -o - "$INFO")
[[ "$IDENTIFIER" == io.github.sarainoq.zhiye ]]
[[ "$(basename "$APP")" == 织页.app ]]
codesign --verify --deep --strict "$APP"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/root/Applications" "$STAGING/scripts"
ditto --norsrc --noextattr --noacl "$APP" "$STAGING/root/Applications/织页.app"
pkgbuild --analyze --root "$STAGING/root" "$STAGING/components.plist"
/usr/libexec/PlistBuddy -c 'Set :0:BundleIsRelocatable false' "$STAGING/components.plist"
/usr/libexec/PlistBuddy -c 'Set :0:BundleOverwriteAction upgrade' "$STAGING/components.plist"

# Replacing a running sidecar can interrupt writes; let the user quit normally.
cat > "$STAGING/scripts/preinstall" <<'SH'
#!/bin/bash
set -euo pipefail
if pgrep -x zhiye >/dev/null; then
  echo '请先保存工作并退出织页，然后重新运行安装包。无需卸载旧版本。' >&2
  exit 1
fi
SH
chmod 755 "$STAGING/scripts/preinstall"
pkgbuild --root "$STAGING/root" --component-plist "$STAGING/components.plist" \
  --scripts "$STAGING/scripts" --identifier "$IDENTIFIER.installer" \
  --version "$VERSION" --install-location / "$OUTPUT"

# Verify that the installer payload cannot replace the user's library directory.
pkgutil --payload-files "$OUTPUT" > "$STAGING/payload.txt"
awk '$0 != "." && $0 != "./Applications" && $0 != "Applications" && $0 != "./._Applications" && $0 != "./Applications/._织页.app" && $0 !~ /^\.?\/?Applications\/织页\.app(\/|$)/ { bad = 1 } END { exit bad }' "$STAGING/payload.txt"
