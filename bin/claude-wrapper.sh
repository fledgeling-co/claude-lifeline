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
#   1. $LIFELINE_REAL_CLAUDE if set (installer records the original symlink target here)
#   2. the newest version under ~/.local/share/claude/versions
#
set -euo pipefail

LIFELINE_HOME="${LIFELINE_HOME:-$HOME/.lifeline}"
GATEWAY_PORT="${LIFELINE_GATEWAY_PORT:-8787}"
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"

# --- locate the real signed binary -------------------------------------------------
real_claude=""
if [[ -n "${LIFELINE_REAL_CLAUDE:-}" && -x "${LIFELINE_REAL_CLAUDE}" ]]; then
  real_claude="${LIFELINE_REAL_CLAUDE}"
elif [[ -f "${LIFELINE_HOME}/real-claude" ]]; then
  candidate="$(cat "${LIFELINE_HOME}/real-claude")"
  [[ -x "${candidate}" ]] && real_claude="${candidate}"
fi
if [[ -z "${real_claude}" ]]; then
  versions_dir="$HOME/.local/share/claude/versions"
  if [[ -d "${versions_dir}" ]]; then
    real_claude="$(ls -t "${versions_dir}" 2>/dev/null | head -1)"
    [[ -n "${real_claude}" ]] && real_claude="${versions_dir}/${real_claude}"
  fi
fi
if [[ -z "${real_claude}" || ! -x "${real_claude}" ]]; then
  echo "lifeline: could not locate the real Claude Code binary; running without it is impossible." >&2
  echo "lifeline: set LIFELINE_REAL_CLAUDE to the path of your claude binary and retry." >&2
  exit 127
fi

# --- ensure the daemon is running --------------------------------------------------
# Best-effort: never block or fail the user's claude invocation on lifeline's account.
if command -v launchctl >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/com.lifeline.daemon" >/dev/null 2>&1 || true
fi

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
