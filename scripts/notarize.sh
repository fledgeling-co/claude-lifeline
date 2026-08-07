#!/usr/bin/env bash
# Notarize and staple a signed lifeline.app, then produce a distributable zip.
#
#   scripts/notarize.sh <path/to/lifeline.app> [OUTPUT_ZIP]
#
# Requires the app to be signed with a Developer ID + hardened runtime (package-app.sh does
# this when DEVELOPER_ID_APP is set). Needs these env vars (from CI secrets or your keychain):
#   APPLE_ID          — the Apple ID email of the account
#   APPLE_TEAM_ID     — the 10-char Team ID
#   APPLE_APP_PASSWORD— an app-specific password for that Apple ID
# If they're absent the script skips notarization with a clear note (a local dev build).
set -euo pipefail

APP="${1:?usage: notarize.sh <lifeline.app> [output.zip]}"
OUT_ZIP="${2:-$(dirname "${APP}")/lifeline.zip}"

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_TEAM_ID:-}" || -z "${APPLE_APP_PASSWORD:-}" ]]; then
  echo "notarize: APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD not set — skipping notarization."
  echo "          (Local/unsigned build. The GitHub release job sets these from repo secrets.)"
  /usr/bin/ditto -c -k --keepParent "${APP}" "${OUT_ZIP}"
  exit 0
fi

echo "==> zipping for submission"
SUBMIT_ZIP="$(mktemp -d)/submit.zip"
/usr/bin/ditto -c -k --keepParent "${APP}" "${SUBMIT_ZIP}"

echo "==> submitting to Apple notary service (this waits for the result)"
xcrun notarytool submit "${SUBMIT_ZIP}" \
  --apple-id "${APPLE_ID}" \
  --team-id "${APPLE_TEAM_ID}" \
  --password "${APPLE_APP_PASSWORD}" \
  --wait

echo "==> stapling the ticket to the app"
xcrun stapler staple "${APP}"
xcrun stapler validate "${APP}"

echo "==> producing the distributable zip"
/usr/bin/ditto -c -k --keepParent "${APP}" "${OUT_ZIP}"
echo "==> notarized + stapled: ${OUT_ZIP}"
