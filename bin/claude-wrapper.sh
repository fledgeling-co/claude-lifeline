#!/usr/bin/env bash
#
# lifeline transparent launcher for Claude Code.
#
# The installer repoints ~/.local/bin/claude at this script. It routes Claude Code
# through the lifeline gateway (so transport failures heal) and ensures the daemon is
# up (so silent agent losses are recovered), then exec's the REAL, untouched, signed
# Claude Code binary. Anthropic's binary is never modified.
#
# Resolution order for the real binary:
#   1. $LIFELINE_REAL_CLAUDE — explicit operator override, always wins.
#   2. the newest SETTLED version under ~/.local/share/claude/versions
#   3. ~/.lifeline/real-claude — last known good, for non-standard installs (npm,
#      homebrew) that have no versions directory, and for the download window
#   4. the newest version at all — last resort
#
# The order matters, and 2-before-3 is the whole point. Claude Code updates by dropping
# a new version into the versions dir and repointing ~/.local/bin/claude — but that
# symlink is ours now, so its repoint never lands. Resolving a RECORDED path first would
# therefore pin you to whatever was current on the day you installed lifeline, silently,
# forever. Resolving newest-at-launch is what keeps `claude` on the version you actually
# have. See README §"How it keeps working when Claude Code updates".
#
set -euo pipefail

LIFELINE_HOME="${LIFELINE_HOME:-$HOME/.lifeline}"
GATEWAY_PORT="${LIFELINE_GATEWAY_PORT:-8787}"
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
VERSIONS_DIR="${LIFELINE_CLAUDE_VERSIONS_DIR:-$HOME/.local/share/claude/versions}"

# A version file is ~265MB and appears the moment its download starts, so "newest" can
# name a half-written binary. A file nothing has touched for this long is finished.
SETTLE_S="${LIFELINE_BINARY_SETTLE_S:-15}"

# --- locate the real signed binary -------------------------------------------------

# Version-shaped entries, newest first. Sorted by version NUMBER, not mtime: mtime
# reorders if an older version is ever re-downloaded or touched.
installed_versions_desc() {
  [[ -d "${VERSIONS_DIR}" ]] || return 0
  ls -1 "${VERSIONS_DIR}" 2>/dev/null \
    | grep -E '^[0-9]+(\.[0-9]+)*$' \
    | sort -t. -k1,1nr -k2,2nr -k3,3nr -k4,4nr
}
# Reverse lives in each key spec, not a trailing `-r`: BSD sort ignores a global `-r`
# once the keys carry their own modifiers, which silently yields OLDEST-first.

file_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# The newest version that has stopped changing. Skipping unsettled candidates means an
# update landing mid-launch leaves you on the previous version for a few seconds rather
# than exec'ing a truncated download.
newest_settled_version() {
  local now candidate path
  now="$(date +%s)"
  while IFS= read -r candidate; do
    path="${VERSIONS_DIR}/${candidate}"
    [[ -n "${candidate}" && -x "${path}" ]] || continue
    if (( now - $(file_mtime "${path}") >= SETTLE_S )); then
      printf '%s\n' "${path}"
      return 0
    fi
  done < <(installed_versions_desc)
  return 1
}

real_claude=""
resolved_from_versions=0
if [[ -n "${LIFELINE_REAL_CLAUDE:-}" && -x "${LIFELINE_REAL_CLAUDE}" ]]; then
  real_claude="${LIFELINE_REAL_CLAUDE}"
elif real_claude="$(newest_settled_version)"; then
  resolved_from_versions=1
else
  real_claude=""
fi
if [[ -z "${real_claude}" && -f "${LIFELINE_HOME}/real-claude" ]]; then
  candidate="$(cat "${LIFELINE_HOME}/real-claude" 2>/dev/null || true)"
  [[ -n "${candidate}" && -x "${candidate}" ]] && real_claude="${candidate}"
fi
if [[ -z "${real_claude}" ]]; then
  # `|| true`: with `set -o pipefail`, grep matching nothing fails the whole pipeline,
  # and a failing assignment under `set -e` would take the script down with it.
  candidate="$(installed_versions_desc | head -1 || true)"
  [[ -n "${candidate}" && -x "${VERSIONS_DIR}/${candidate}" ]] && real_claude="${VERSIONS_DIR}/${candidate}"
fi
if [[ -z "${real_claude}" || ! -x "${real_claude}" ]]; then
  echo "lifeline: could not locate the real Claude Code binary; running without it is impossible." >&2
  echo "lifeline: set LIFELINE_REAL_CLAUDE to the path of your claude binary and retry." >&2
  exit 127
fi

# Keep the recorded fallback pointing at the last version we actually launched, so step 3
# is "last known good" rather than an install-day fossil — and so uninstall restores you
# to a current binary. Only ever written from a versions-dir resolution: an npm or
# homebrew install's recorded path must survive untouched.
if (( resolved_from_versions )) \
  && [[ "$(cat "${LIFELINE_HOME}/real-claude" 2>/dev/null || true)" != "${real_claude}" ]]; then
  printf '%s\n' "${real_claude}" > "${LIFELINE_HOME}/real-claude" 2>/dev/null || true
fi

# --- ensure the daemon is running --------------------------------------------------
# Best-effort: never block or fail the user's claude invocation on lifeline's account.
if command -v launchctl >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/com.lifeline.daemon" >/dev/null 2>&1 || true
fi

# --- keep claude routed through the gateway ----------------------------------------
# Claude Code applies ~/.claude/settings.json `env` itself, and that OUTRANKS anything this
# script exports. So a base URL there that isn't the gateway takes lifeline out of the
# request path entirely, and nothing says so: retries stop happening and everything still
# looks fine. It drifts back for ordinary reasons (a restored settings backup, another tool
# writing the file, re-adding a proxy by hand), so we re-assert the chain at launch.
#
# Both topologies end up correct, because whatever we displace becomes the upstream:
#   with a proxy:    claude -> lifeline -> proxy -> api
#   without one:     claude -> lifeline -> api
#
# Set LIFELINE_NO_SETTINGS_HEAL=1 to leave settings.json alone.
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
heal_settings_chain() {
  [[ "${LIFELINE_NO_SETTINGS_HEAL:-0}" != "1" ]] || return 0
  [[ -f "${CLAUDE_SETTINGS}" && -f "${LIFELINE_HOME}/patch-settings.mjs" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  # Fast path: a settings file with no base URL needs nothing (our exported env wins), and
  # one already naming the gateway is correct. Only the mismatch case pays for node.
  grep -q 'ANTHROPIC_BASE_URL' "${CLAUDE_SETTINGS}" || return 0
  grep -qF "\"${GATEWAY_URL}\"" "${CLAUDE_SETTINGS}" && return 0

  local displaced
  displaced="$(LIFELINE_HOME="${LIFELINE_HOME}" CLAUDE_SETTINGS="${CLAUDE_SETTINGS}" \
    node "${LIFELINE_HOME}/patch-settings.mjs" apply "${GATEWAY_URL}" 2>/dev/null || true)"
  [[ -n "${displaced}" ]] || return 0

  # Point the gateway at what we displaced, and restart it ONLY if that actually changed:
  # a needless restart would cut in-flight requests from other claude sessions.
  local changed
  changed="$(LIFELINE_HOME="${LIFELINE_HOME}" node -e '
    const fs = require("fs"), path = require("path");
    const p = path.join(process.env.LIFELINE_HOME, "config.json");
    const next = process.argv[1];
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    if (cfg.upstream === next) { process.stdout.write(""); }
    else { cfg.upstream = next; fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
           process.stdout.write("changed"); }
  ' "${displaced}" 2>/dev/null || true)"

  if [[ "${changed}" == "changed" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.lifeline.gateway" >/dev/null 2>&1 || true
  fi
  echo "lifeline: claude was routed past the gateway; re-chained it (upstream ${displaced})" >&2
}
heal_settings_chain || true

# --- route through the gateway if it is up -----------------------------------------
# We only set ANTHROPIC_BASE_URL when the gateway answers, so a stopped gateway never
# breaks claude; it just runs unhealed.
#
# If ANTHROPIC_BASE_URL is ALREADY set to something other than the gateway (e.g. a
# multi-account proxy), we do NOT clobber it: that routing is user intent. The installer
# captures such a proxy as the gateway's upstream so the chain becomes
# claude -> lifeline-gw -> proxy -> api; if the user later exports a different base url
# in their shell, respecting it beats silently re-routing them. `lifeline doctor`
# reports when claude is bypassing the gateway. A user-set ANTHROPIC_API_KEY also
# bypasses the gateway's benefit (documented in the README).
if [[ -n "${ANTHROPIC_BASE_URL:-}" && "${ANTHROPIC_BASE_URL}" != "${GATEWAY_URL}" ]]; then
  : # user has explicit routing — leave it alone
elif curl -fsS -m 1 "${GATEWAY_URL}/" >/dev/null 2>&1; then
  export ANTHROPIC_BASE_URL="${GATEWAY_URL}"
fi

# --- record this terminal so the status app can reveal it ---------------------------
# The app maps a workflow's controlling tty back to a window/tab. We record, keyed by tty,
# which terminal program owns it, the cwd, and our pid. Best-effort; never fatal.
{
  ll_tty="$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')"
  if [[ -n "${ll_tty}" && "${ll_tty}" != "??" ]]; then
    ll_safe="${ll_tty//\//_}"
    mkdir -p "${LIFELINE_HOME}/terminals" 2>/dev/null || true
    cat > "${LIFELINE_HOME}/terminals/${ll_safe}.json" 2>/dev/null <<JSON || true
{"tty":"/dev/${ll_tty}","term":"${TERM_PROGRAM:-unknown}","cwd":"${PWD}","pid":$$,"at":$(date +%s)}
JSON
    # A distinctive title makes Ghostty/Warp/Alacritty (which expose no tty) matchable too.
    printf '\033]2;lifeline · %s\007' "$(basename "${PWD}")" >/dev/tty 2>/dev/null || true
  fi
} 2>/dev/null || true

exec "${real_claude}" "$@"
