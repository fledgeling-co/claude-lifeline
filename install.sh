#!/usr/bin/env bash
#
# lifeline installer — one command, macOS, set and forget.
#
#   curl -fsSL https://raw.githubusercontent.com/fledgeling-co/claude-lifeline/main/install.sh | bash
#
# What it does, and nothing it doesn't:
#   - clones/uses the lifeline repo, installs deps, builds
#   - starts the gateway + daemon + version watcher as launchd agents
#   - repoints ~/.local/bin/claude at a transparent wrapper that routes claude
#     through the gateway and ensures the daemon is up, then exec's the REAL,
#     untouched, code-signed Claude Code binary
#   - records a fingerprint baseline of the installed CLI contract
#
# It never modifies Anthropic's binary. Re-running is safe (idempotent).
#
set -euo pipefail

REPO_URL="${LIFELINE_REPO_URL:-https://github.com/fledgeling-co/claude-lifeline.git}"
BRANCH="${LIFELINE_BRANCH:-main}"
LIFELINE_HOME="${LIFELINE_HOME:-$HOME/.lifeline}"
APP_DIR="${LIFELINE_HOME}/app"
GATEWAY_PORT="${LIFELINE_GATEWAY_PORT:-8787}"
# Upstream resolution: an explicit LIFELINE_UPSTREAM wins; otherwise, if the user
# already routes claude through a proxy — via shell env OR ~/.claude/settings.json env
# (which Claude Code applies itself and which outranks inherited env) — CHAIN it: the
# gateway forwards to the proxy, which forwards to the API.
settings_base_url=""
if command -v node >/dev/null 2>&1 && [[ -f "$HOME/.claude/settings.json" ]]; then
  settings_base_url="$(node -e '
    try { const s = require(process.env.HOME + "/.claude/settings.json");
      process.stdout.write((s.env && s.env.ANTHROPIC_BASE_URL) || ""); } catch {}' 2>/dev/null || true)"
fi
if [[ -n "${LIFELINE_UPSTREAM:-}" ]]; then
  UPSTREAM="${LIFELINE_UPSTREAM}"
elif [[ -n "${settings_base_url}" && "${settings_base_url}" != http://127.0.0.1:${GATEWAY_PORT}* ]]; then
  UPSTREAM="${settings_base_url}"
elif [[ -n "${ANTHROPIC_BASE_URL:-}" && "${ANTHROPIC_BASE_URL}" != http://127.0.0.1:${GATEWAY_PORT}* ]]; then
  UPSTREAM="${ANTHROPIC_BASE_URL}"
else
  UPSTREAM="https://api.anthropic.com"
fi
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOCAL_BIN="$HOME/.local/bin"
CLAUDE_VERSIONS_DIR="$HOME/.local/share/claude/versions"

say()  { printf '\033[36mlifeline\033[0m %s\n' "$*"; }
warn() { printf '\033[33mlifeline\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mlifeline\033[0m %s\n' "$*" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "this installer targets macOS. See the README for other platforms."
command -v git  >/dev/null 2>&1 || die "git is required."
command -v node >/dev/null 2>&1 || die "Node.js 22+ is required (https://nodejs.org). Install it and re-run."
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge 22 ]] || die "Node 22+ required; found $(node -v)."

mkdir -p "${LIFELINE_HOME}/logs" "${LIFELINE_HOME}/fingerprints" "${LAUNCH_AGENTS}" "${LOCAL_BIN}"

# --- obtain the source -------------------------------------------------------------
# If this script sits inside a checkout, use it; otherwise clone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/package.json" ]]; then
  SRC="${SCRIPT_DIR}"
  say "using local checkout at ${SRC}"
else
  if [[ -d "${APP_DIR}/.git" ]]; then
    say "updating existing checkout"
    git -C "${APP_DIR}" fetch --quiet origin "${BRANCH}"
    git -C "${APP_DIR}" checkout --quiet "${BRANCH}"
    git -C "${APP_DIR}" reset --hard --quiet "origin/${BRANCH}"
  else
    say "cloning ${REPO_URL}"
    rm -rf "${APP_DIR}"
    git clone --quiet --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}"
  fi
  SRC="${APP_DIR}"
fi

# --- build -------------------------------------------------------------------------
say "installing dependencies and building"
( cd "${SRC}" && npm install --no-audit --no-fund --silent && npm run build --silent )
[[ -f "${SRC}/dist/gateway/server.js" ]] || die "build did not produce dist/. Check ${LIFELINE_HOME}/logs."

# --- config ------------------------------------------------------------------------
# lifeline owns this file: merge-update the routing keys on every install so a changed
# proxy or port takes effect, preserving any hand-edited tuning keys.
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  cfg.gatewayHost = "127.0.0.1";
  cfg.gatewayPort = Number(process.argv[2]);
  cfg.upstream = process.argv[3];
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "${LIFELINE_HOME}/config.json" "${GATEWAY_PORT}" "${UPSTREAM}"
say "config: gateway :${GATEWAY_PORT} -> upstream ${UPSTREAM}"

# --- record the real claude binary + repoint the launcher --------------------------
CLAUDE_LINK="${LOCAL_BIN}/claude"
real_target=""
if [[ -L "${CLAUDE_LINK}" ]]; then
  real_target="$(readlink "${CLAUDE_LINK}")"
elif [[ -x "${CLAUDE_LINK}" && "$(head -c 4 "${CLAUDE_LINK}" 2>/dev/null || true)" != $'#!/u' ]]; then
  real_target="${CLAUDE_LINK}"   # a real binary, not our wrapper
fi
# If the link already points at our wrapper, keep the previously recorded real target.
if [[ -z "${real_target}" || "${real_target}" == *"claude-wrapper.sh" ]]; then
  if [[ -f "${LIFELINE_HOME}/real-claude" ]]; then
    real_target="$(cat "${LIFELINE_HOME}/real-claude")"
  fi
fi
# Fall back to the newest installed version.
if [[ -z "${real_target}" && -d "${CLAUDE_VERSIONS_DIR}" ]]; then
  newest="$(ls -t "${CLAUDE_VERSIONS_DIR}" 2>/dev/null | head -1 || true)"
  [[ -n "${newest}" ]] && real_target="${CLAUDE_VERSIONS_DIR}/${newest}"
fi
[[ -n "${real_target}" && -x "${real_target}" ]] || die "could not find your real claude binary. Install Claude Code first."

echo "${real_target}" > "${LIFELINE_HOME}/real-claude"
say "real Claude Code binary: ${real_target}"

# Install the wrapper and repoint the launcher.
install -m 0755 "${SRC}/bin/claude-wrapper.sh" "${LIFELINE_HOME}/claude-wrapper.sh"
if [[ -e "${CLAUDE_LINK}" || -L "${CLAUDE_LINK}" ]]; then
  cp -a "${CLAUDE_LINK}" "${LIFELINE_HOME}/claude.pre-lifeline.bak" 2>/dev/null || true
  rm -f "${CLAUDE_LINK}"
fi
ln -s "${LIFELINE_HOME}/claude-wrapper.sh" "${CLAUDE_LINK}"
say "repointed ${CLAUDE_LINK} -> lifeline wrapper (claude stays your command)"

# --- render + load launchd agents --------------------------------------------------
render() { sed \
  -e "s|@@NODE@@|${NODE_BIN}|g" \
  -e "s|@@LIFELINE_DIR@@|${SRC}|g" \
  -e "s|@@LIFELINE_HOME@@|${LIFELINE_HOME}|g" \
  -e "s|@@GATEWAY_PORT@@|${GATEWAY_PORT}|g" \
  -e "s|@@CLAUDE_VERSIONS_DIR@@|${CLAUDE_VERSIONS_DIR}|g" \
  -e "s|@@PATH@@|${PATH}|g" \
  "$1"; }

for svc in gateway daemon watcher; do
  plist="${LAUNCH_AGENTS}/com.lifeline.${svc}.plist"
  render "${SRC}/install/com.lifeline.${svc}.plist.tmpl" > "${plist}"
  launchctl bootout "gui/$(id -u)/com.lifeline.${svc}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "${plist}" >/dev/null 2>&1 || launchctl load "${plist}" >/dev/null 2>&1 || true
  say "loaded com.lifeline.${svc}"
done

# --- chain ~/.claude/settings.json through the gateway ------------------------------
# Claude Code applies settings.json env itself (outranking the wrapper's export), so if a
# base URL lives there it must be repointed at the gateway; its old value is already the
# gateway's upstream. Recorded for exact revert by uninstall.sh.
if [[ -n "${settings_base_url}" ]]; then
  captured="$(LIFELINE_HOME="${LIFELINE_HOME}" "${NODE_BIN}" "${SRC}/install/patch-settings.mjs" apply "http://127.0.0.1:${GATEWAY_PORT}")" || true
  say "settings.json base URL -> gateway (was: ${captured:-none}; now chained through it)"
fi

# --- fingerprint baseline for the installed version --------------------------------
"${NODE_BIN}" "${SRC}/dist/fingerprint/index.js" --baseline >/dev/null 2>&1 || \
  warn "could not compute a fingerprint baseline yet; 'lifeline doctor' will report version status."

# --- register the MCP server so the Claude Code model knows about lifeline ----------
# Tool descriptions are how claude's own model learns it can retry/pause/resume runs.
if "${CLAUDE_LINK}" mcp list 2>/dev/null | grep -q '^lifeline\b'; then
  say "MCP server already registered"
else
  "${CLAUDE_LINK}" mcp add --scope user lifeline -- "${NODE_BIN}" "${SRC}/dist/mcp/index.js" \
    >/dev/null 2>&1 && say "registered lifeline MCP server (user scope)" || \
    warn "could not register the MCP server automatically; run: claude mcp add --scope user lifeline -- ${NODE_BIN} ${SRC}/dist/mcp/index.js"
fi

# --- done --------------------------------------------------------------------------
say "installed. Running a health check:"
"${NODE_BIN}" "${SRC}/dist/cli/index.js" doctor || true
cat <<EOF

lifeline is set up. Your command is still 'claude'.
  - status:  lifeline status
  - health:  lifeline doctor
  - remove:  curl -fsSL https://raw.githubusercontent.com/fledgeling-co/claude-lifeline/main/uninstall.sh | bash

Note: if you set ANTHROPIC_API_KEY directly, claude bypasses the gateway and lifeline
can't heal transport errors on that path. 'lifeline doctor' will warn you if so.
EOF
