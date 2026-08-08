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
VERSIONS_DIR="${LIFELINE_CLAUDE_VERSIONS_DIR:-$HOME/.local/share/claude/versions}"

# The gateway's port comes from config.json — the file the gateway itself is configured from.
# LIFELINE_GATEWAY_PORT is set in the gateway's launchd plist, not in an ordinary terminal, so
# trusting the shell alone would invent :8787 for anyone who installed on another port: we would
# then pin settings.json to a dead port AND hand the real gateway URL to the gateway as its own
# upstream. An explicit value in the environment still wins, as an operator override.
GATEWAY_PORT="${LIFELINE_GATEWAY_PORT:-}"
if [[ -z "${GATEWAY_PORT}" && -f "${LIFELINE_HOME}/config.json" ]]; then
  GATEWAY_PORT="$(sed -n 's/.*"gatewayPort"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    "${LIFELINE_HOME}/config.json" 2>/dev/null | head -1 || true)"
fi
[[ "${GATEWAY_PORT}" =~ ^[0-9]+$ ]] || GATEWAY_PORT=8787
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"

# A version file is ~265MB and appears the moment its download starts, so "newest" can
# name a half-written binary. A file nothing has touched for this long is finished.
# Validated because it is expanded inside (( )), where a non-numeric value is a syntax error
# at best and an arbitrary evaluated expression at worst.
SETTLE_S="${LIFELINE_BINARY_SETTLE_S:-15}"
[[ "${SETTLE_S}" =~ ^[0-9]+$ ]] || SETTLE_S=15

# Compare two URLs the way a server would: case, trailing slashes and the localhost/127.0.0.1
# spelling are all the same endpoint. Used to keep the gateway from becoming its own upstream.
normalize_url() {
  local u
  u="$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
  while [[ "${u}" == */ ]]; do u="${u%/}"; done
  printf '%s' "${u//\/\/localhost:/\/\/127.0.0.1:}"
}

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
  local m
  # GNU first: on GNU coreutils `-f` means --file-system, so `stat -f %m` SUCCEEDS there while
  # printing a literal `%m`. A BSD-first chain therefore never reaches the `-c` fallback on
  # Linux and feeds `%m` straight into (( )). BSD stat has no `-c`, so it errors and falls
  # through here. Anything non-numeric is treated as "unknown, assume not settled yet".
  m="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true)"
  # Fail closed: report NOW, so an age of 0 reads as "still changing" and the candidate is
  # skipped. Reporting 0 (the epoch) would read as settled decades ago and do the opposite,
  # exec'ing a file we could not even stat.
  [[ "${m}" =~ ^[0-9]+$ ]] || m="$(date +%s)"
  printf '%s\n' "${m}"
}

# The newest version that has stopped changing. Skipping unsettled candidates means an
# update landing mid-launch leaves you on the previous version for a few seconds rather
# than exec'ing a truncated download.
newest_settled_version() {
  local now candidate path
  now="$(date +%s)"
  while IFS= read -r candidate; do
    path="${VERSIONS_DIR}/${candidate}"
    # -f as well as -x: a directory is executable (searchable) too, and exec'ing one fails
    # with an error that never reaches the "could not locate the binary" guidance below.
    [[ -n "${candidate}" && -f "${path}" && -x "${path}" ]] || continue
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
fi
# No `else` arm: the command substitution above assigns whatever it printed, which on failure
# is the empty string already.
if [[ -z "${real_claude}" && -f "${LIFELINE_HOME}/real-claude" ]]; then
  candidate="$(cat "${LIFELINE_HOME}/real-claude" 2>/dev/null || true)"
  [[ -n "${candidate}" && -f "${candidate}" && -x "${candidate}" ]] && real_claude="${candidate}"
fi
if [[ -z "${real_claude}" ]]; then
  # `|| true`: with `set -o pipefail`, grep matching nothing fails the whole pipeline,
  # and a failing assignment under `set -e` would take the script down with it.
  candidate="$(installed_versions_desc | head -1 || true)"
  if [[ -n "${candidate}" && -f "${VERSIONS_DIR}/${candidate}" && -x "${VERSIONS_DIR}/${candidate}" ]]; then
    real_claude="${VERSIONS_DIR}/${candidate}"
    # Still a versions-dir resolution. Recording it is what stops `lifeline doctor` reporting
    # a pin the wrapper is not doing, for the whole window in which nothing has settled yet.
    resolved_from_versions=1
  fi
fi
if [[ -z "${real_claude}" || ! -x "${real_claude}" ]]; then
  echo "lifeline: could not locate the real Claude Code binary; running without it is impossible." >&2
  echo "lifeline: set LIFELINE_REAL_CLAUDE to the path of your claude binary and retry." >&2
  exit 127
fi

# Keep the recorded fallback pointing at the last version we actually launched, so step 3
# is "last known good" rather than an install-day fossil — and so uninstall restores you
# to a current binary.
#
# Guarded on the RECORD, not just on how we resolved: a record pointing outside the versions
# directory is an npm/homebrew install's own launcher (or a user's shim), it is the only copy
# uninstall has, and a machine can have both that and a versions directory. Overwriting it
# would make uninstall hand back a raw binary instead of the launcher the user had.
if (( resolved_from_versions )); then
  prev_record="$(cat "${LIFELINE_HOME}/real-claude" 2>/dev/null || true)"
  if [[ ( -z "${prev_record}" || "${prev_record}" == "${VERSIONS_DIR}/"* ) \
        && "${prev_record}" != "${real_claude}" ]]; then
    # Write via a temp file: several sessions start together right after an update, and an
    # interleaved truncating redirect leaves the record empty or two lines long.
    if printf '%s\n' "${real_claude}" > "${LIFELINE_HOME}/real-claude.$$.tmp" 2>/dev/null; then
      mv -f "${LIFELINE_HOME}/real-claude.$$.tmp" "${LIFELINE_HOME}/real-claude" 2>/dev/null \
        || rm -f "${LIFELINE_HOME}/real-claude.$$.tmp" 2>/dev/null || true
    fi
  fi
fi

# --- ensure the daemon is running --------------------------------------------------
# Best-effort: never block or fail the user's claude invocation on lifeline's account.
#
# No `-k`. That flag KILLS a running job and starts it again, and this runs on every single
# claude launch — so on a machine with several sessions the recovery daemon was being torn down
# every few seconds, losing whatever it had in flight (a scheduled nudge, a summary mid-call)
# and re-reading every ledger each time. Plain `kickstart` starts it if it is not running and
# does nothing if it is, which is all "ensure the daemon is running" ever meant.
if command -v launchctl >/dev/null 2>&1; then
  launchctl kickstart "gui/$(id -u)/com.lifeline.daemon" >/dev/null 2>&1 || true
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
CLAUDE_SETTINGS="${LIFELINE_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
# Liveness means "something answered HTTP", NOT "answered 2xx". The gateway serves 404 at `/`
# (it only proxies the API paths), and `curl -f` turns any 4xx into a non-zero exit — so an -f
# probe reports a perfectly healthy gateway as dead. `lifeline doctor` has always counted the
# 404 as proof of life; this now agrees with it. Exit 0 = a response arrived, 7 = refused.
gateway_answers() { curl -sS -m 1 -o /dev/null "${GATEWAY_URL}/" >/dev/null 2>&1; }
# `.` is the only regex metacharacter in a host:port URL, but an unescaped one would let
# 127x0x0x1 match the gateway and skip a heal that was needed.
gateway_url_ere="${GATEWAY_URL//./\\.}"
heal_settings_chain() {
  [[ "${LIFELINE_NO_SETTINGS_HEAL:-0}" != "1" ]] || return 0
  [[ -f "${CLAUDE_SETTINGS}" && -f "${LIFELINE_HOME}/patch-settings.mjs" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  # Fast path, cheap and deliberately one-sided. A settings file with no base URL at all needs
  # nothing (our exported env wins), and the key already assigned the gateway is correct.
  # Anything else falls through to the patcher, which compares URLs properly. The second
  # pattern is anchored to the KEY rather than searching the whole file for the URL: a grep
  # that misses a `localhost` spelling only costs a node start, whereas one that matched the
  # gateway URL sitting under some other key would skip a heal that was needed.
  grep -q 'ANTHROPIC_BASE_URL' "${CLAUDE_SETTINGS}" || return 0
  grep -qE '"ANTHROPIC_BASE_URL"[[:space:]]*:[[:space:]]*"'"${gateway_url_ere}"'/*"' \
    "${CLAUDE_SETTINGS}" && return 0

  # Only chain into a gateway that is actually answering. Unlike the per-process export below,
  # this write is durable and outranks the environment, so pointing settings.json at a gateway
  # that is down would take claude off the air until someone edited the file by hand — the
  # opposite of the "a stopped gateway never breaks claude" property stated further down.
  gateway_answers || return 0

  local displaced
  displaced="$(LIFELINE_HOME="${LIFELINE_HOME}" LIFELINE_CLAUDE_SETTINGS="${CLAUDE_SETTINGS}" \
    node "${LIFELINE_HOME}/patch-settings.mjs" apply "${GATEWAY_URL}" 2>/dev/null || true)"
  if [[ -z "${displaced}" ]]; then
    # Nothing was displaced, but settings.json may still have been pinned to the gateway.
    # Say so: silently editing the user's settings is the most surprising thing we do.
    echo "lifeline: pinned settings.json to the gateway (${GATEWAY_URL})" >&2
    return 0
  fi

  # Never let the gateway become its own upstream. The patcher normalises too; this is the
  # second line of defence, because an upstream that resolves back to the listener turns one
  # request into an unbounded chain of nested requests and takes claude down completely.
  if [[ "$(normalize_url "${displaced}")" == "$(normalize_url "${GATEWAY_URL}")" ]]; then
    return 0
  fi

  # Point the gateway at what we displaced, and restart it ONLY if that actually changed:
  # a needless restart would cut in-flight requests from other claude sessions.
  local changed
  changed="$(LIFELINE_HOME="${LIFELINE_HOME}" node -e '
    const fs = require("fs"), path = require("path");
    const p = path.join(process.env.LIFELINE_HOME, "config.json");
    const next = process.argv[1];
    let raw = null;
    try { raw = fs.readFileSync(p, "utf8"); } catch { raw = null; }
    let cfg = {};
    if (raw !== null) {
      // A config we cannot parse is a config we must not REPLACE: writing {upstream} over it
      // would drop gatewayHost, gatewayPort and every hand-tuned key, and loadConfig swallows
      // the parse error and silently falls back to the plain API.
      try { cfg = JSON.parse(raw); } catch { process.stdout.write("unreadable"); process.exit(0); }
    }
    if (cfg.upstream === next) { process.stdout.write(""); }
    else {
      cfg.upstream = next;
      // Temp + rename: the gateway, daemon, watcher and CLI all read this file on their own
      // schedule, and this now runs on every launch rather than once at install.
      const tmp = p + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
      fs.renameSync(tmp, p);
      process.stdout.write("changed");
    }
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
elif gateway_answers; then
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
