#!/usr/bin/env bash
# Package the lifeline menu-bar app into a proper macOS .app bundle.
#
#   scripts/package-app.sh [VERSION] [OUTPUT_DIR]
#
# Produces  <OUTPUT_DIR>/lifeline.app  (default OUTPUT_DIR=dist-app), code-signed with
# DEVELOPER_ID_APP if that env var is set (required for notarization), otherwise ad-hoc.
# The bundle is a menu-bar accessory (LSUIElement), so it has no Dock icon.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-${VERSION:-0.0.0-dev}}"
VERSION="${VERSION#v}" # tolerate a leading v from a git tag
OUT="${2:-${ROOT}/dist-app}"
APP="${OUT}/lifeline.app"
BUNDLE_ID="co.fledgeling.lifeline"

echo "==> packaging lifeline.app  version=${VERSION}"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

# 1. Compile the menu-bar binary (universal where the toolchain allows).
echo "--> compiling menu-bar binary"
ARCH_FLAGS=()
if swiftc -target arm64-apple-macos13 -e "" >/dev/null 2>&1; then :; fi
swiftc -O -parse-as-library \
  "${ROOT}/menubar/lifeline-menubar.swift" "${ROOT}/menubar/TerminalRevealer.swift" \
  -o "${APP}/Contents/MacOS/lifeline"
chmod +x "${APP}/Contents/MacOS/lifeline"

# 2. Icon: generate a 1024 PNG, expand to an iconset, compile to .icns.
echo "--> building AppIcon.icns"
TMP_ICON="$(mktemp -d)"
swiftc -O "${ROOT}/scripts/icon-gen.swift" -o "${TMP_ICON}/icongen"
"${TMP_ICON}/icongen" "${TMP_ICON}/icon_1024.png"
ICONSET="${TMP_ICON}/AppIcon.iconset"
mkdir -p "${ICONSET}"
for sz in 16 32 64 128 256 512 1024; do
  sips -z "$sz" "$sz" "${TMP_ICON}/icon_1024.png" --out "${ICONSET}/icon_${sz}x${sz}.png" >/dev/null
  half=$((sz / 2))
  [ "$half" -ge 16 ] && cp "${ICONSET}/icon_${sz}x${sz}.png" "${ICONSET}/icon_${half}x${half}@2x.png" 2>/dev/null || true
done
iconutil -c icns "${ICONSET}" -o "${APP}/Contents/Resources/AppIcon.icns"
rm -rf "${TMP_ICON}"

# 3. Ship the install/uninstall scripts inside the bundle so the app can self-repair/uninstall.
cp "${ROOT}/install.sh" "${ROOT}/uninstall.sh" "${APP}/Contents/Resources/" 2>/dev/null || true

# 4. Info.plist — menu-bar accessory, no Dock icon.
cat > "${APP}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>lifeline</string>
  <key>CFBundleDisplayName</key><string>lifeline</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>lifeline</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT licensed. github.com/fledgeling-co/claude-lifeline</string>
</dict>
</plist>
PLIST

# 5. Sign. Developer ID + hardened runtime when the identity is present (needed to notarize),
# otherwise an ad-hoc signature so it at least launches locally.
if [[ -n "${DEVELOPER_ID_APP:-}" ]]; then
  echo "--> signing with Developer ID (hardened runtime)"
  codesign --force --deep --options runtime --timestamp \
    --sign "${DEVELOPER_ID_APP}" "${APP}"
else
  echo "--> no DEVELOPER_ID_APP set; ad-hoc signing (not notarizable)"
  codesign --force --deep --sign - "${APP}"
fi
codesign --verify --strict --verbose=2 "${APP}" || true

echo "==> built ${APP}"
