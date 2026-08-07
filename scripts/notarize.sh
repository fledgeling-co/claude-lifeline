#!/usr/bin/env bash
# Notarize and staple a signed lifeline.app, then produce a distributable zip.
#
#   scripts/notarize.sh <path/to/lifeline.app> [OUTPUT_ZIP]
#
# Requires the app to be signed with a Developer ID + hardened runtime (package-app.sh does
# this when DEVELOPER_ID_APP is set). Authenticates to the notary service with, in order:
#   1. an App Store Connect API key   ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH  (preferred)
#   2. an Apple ID app password       APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD
# These come from .env.local locally, or CI secrets. If neither is set it skips notarization
# with a clear note (a local dev build).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "${ROOT}/.env.local" ] && set -a && . "${ROOT}/.env.local" && set +a

APP="${1:?usage: notarize.sh <lifeline.app> [output.zip]}"
OUT_ZIP="${2:-$(dirname "${APP}")/lifeline.zip}"

# Resolve ASC_KEY_PATH relative to the repo root when it's a relative path.
if [[ -n "${ASC_KEY_PATH:-}" && "${ASC_KEY_PATH}" != /* ]]; then ASC_KEY_PATH="${ROOT}/${ASC_KEY_PATH}"; fi

NOTARY_ARGS=()
if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -n "${ASC_KEY_PATH:-}" && -f "${ASC_KEY_PATH}" ]]; then
  echo "notarize: using App Store Connect API key ${ASC_KEY_ID}"
  NOTARY_ARGS=(--key "${ASC_KEY_PATH}" --key-id "${ASC_KEY_ID}" --issuer "${ASC_ISSUER_ID}")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
  echo "notarize: using Apple ID ${APPLE_ID}"
  NOTARY_ARGS=(--apple-id "${APPLE_ID}" --team-id "${APPLE_TEAM_ID}" --password "${APPLE_APP_PASSWORD}")
else
  echo "notarize: no App Store Connect key or Apple ID credentials set — skipping notarization."
  echo "          (Local/unsigned build. Set them in .env.local or CI secrets to notarise.)"
  /usr/bin/ditto -c -k --keepParent "${APP}" "${OUT_ZIP}"
  exit 0
fi

echo "==> zipping for submission"
SUBMIT_ZIP="$(mktemp -d)/submit.zip"
/usr/bin/ditto -c -k --keepParent "${APP}" "${SUBMIT_ZIP}"

echo "==> submitting to Apple notary service (this waits for the result)"
xcrun notarytool submit "${SUBMIT_ZIP}" "${NOTARY_ARGS[@]}" --wait

echo "==> stapling the ticket to the app"
xcrun stapler staple "${APP}"
xcrun stapler validate "${APP}"

echo "==> producing the distributable zip"
/usr/bin/ditto -c -k --keepParent "${APP}" "${OUT_ZIP}"
echo "==> notarized + stapled: ${OUT_ZIP}"
