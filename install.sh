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
# On a re-install the settings value is ALREADY the gateway, so it can no longer tell us
# what sits behind it. Recover the proxy from the existing config (then the recorded
# original) instead of falling through to the API, which would silently drop a chained
# proxy out of the route on every re-run.
existing_upstream=""
if command -v node >/dev/null 2>&1; then
  existing_upstream="$(LIFELINE_HOME="${LIFELINE_HOME}" node -e '
    const fs = require("fs"), path = require("path");
    const home = process.env.LIFELINE_HOME;
    const read = (p, k) => { try { return JSON.parse(fs.readFileSync(p, "utf8"))[k] || ""; } catch { return ""; } };
    const fromConfig = read(path.join(home, "config.json"), "upstream");
    const fromRecord = read(path.join(home, "settings-base-url.orig.json"), "original");
    process.stdout.write(fromConfig || fromRecord || "");' 2>/dev/null || true)"
fi

if [[ -n "${LIFELINE_UPSTREAM:-}" ]]; then
  UPSTREAM="${LIFELINE_UPSTREAM}"
elif [[ -n "${settings_base_url}" && "${settings_base_url}" != http://127.0.0.1:${GATEWAY_PORT}* ]]; then
  UPSTREAM="${settings_base_url}"
elif [[ -n "${ANTHROPIC_BASE_URL:-}" && "${ANTHROPIC_BASE_URL}" != http://127.0.0.1:${GATEWAY_PORT}* ]]; then
  UPSTREAM="${ANTHROPIC_BASE_URL}"
elif [[ -n "${existing_upstream}" && "${existing_upstream}" != http://127.0.0.1:${GATEWAY_PORT}* \
        && -n "${settings_base_url}" && "${settings_base_url}" == http://127.0.0.1:${GATEWAY_PORT}* ]]; then
  # Only when settings.json ALREADY names the gateway, i.e. the case this branch exists for:
  # the settings value can no longer tell us what sits behind it. Unconditionally trusting the
  # recorded upstream would make it sticky — a user who removed their proxy could never get
  # back to the plain API by re-running the installer.
  UPSTREAM="${existing_upstream}"
else
  UPSTREAM="https://api.anthropic.com"
fi
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOCAL_BIN="$HOME/.local/bin"
CLAUDE_VERSIONS_DIR="${LIFELINE_CLAUDE_VERSIONS_DIR:-$HOME/.local/share/claude/versions}"

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
  if (cfg.upstream !== process.argv[3]) delete cfg.relayBridge;
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
# Fall back to the newest installed version — by version number, not mtime, which reorders
# whenever an older version is re-downloaded.
if [[ -z "${real_target}" && -d "${CLAUDE_VERSIONS_DIR}" ]]; then
  newest="$(ls -1 "${CLAUDE_VERSIONS_DIR}" 2>/dev/null \
    | grep -E '^[0-9]+(\.[0-9]+)*$' \
    | sort -t. -k1,1nr -k2,2nr -k3,3nr -k4,4nr | head -1 || true)"
  [[ -n "${newest}" ]] && real_target="${CLAUDE_VERSIONS_DIR}/${newest}"
fi
[[ -n "${real_target}" && -x "${real_target}" ]] || die "could not find your real claude binary. Install Claude Code first."

# A FALLBACK, not a pin. The wrapper resolves the newest installed version at launch and
# refreshes this file to whatever it last ran, so Claude Code updates take effect on their
# own; this recorded path only matters for installs with no versions directory (npm,
# homebrew) and for the seconds while a new version is still downloading.
echo "${real_target}" > "${LIFELINE_HOME}/real-claude"
say "real Claude Code binary: ${real_target}"

# Install the wrapper and repoint the launcher.
install -m 0755 "${SRC}/bin/claude-wrapper.sh" "${LIFELINE_HOME}/claude-wrapper.sh"
# Keep a copy of the uninstaller where the menu-bar app's "Uninstall" action looks for it.
install -m 0755 "${SRC}/uninstall.sh" "${LIFELINE_HOME}/uninstall.sh" 2>/dev/null \
  || cp "${SRC}/uninstall.sh" "${LIFELINE_HOME}/uninstall.sh" 2>/dev/null || true
# The wrapper re-chains settings.json on launch when it has drifted, so the patcher has to
# live somewhere that survives the checkout being moved or deleted.
install -m 0755 "${SRC}/install/patch-settings.mjs" "${LIFELINE_HOME}/patch-settings.mjs" 2>/dev/null \
  || cp "${SRC}/install/patch-settings.mjs" "${LIFELINE_HOME}/patch-settings.mjs" 2>/dev/null || true
install -m 0755 "${SRC}/install/update-gateway-upstream.mjs" "${LIFELINE_HOME}/update-gateway-upstream.mjs" 2>/dev/null \
  || cp "${SRC}/install/update-gateway-upstream.mjs" "${LIFELINE_HOME}/update-gateway-upstream.mjs" 2>/dev/null || true
if [[ -e "${CLAUDE_LINK}" || -L "${CLAUDE_LINK}" ]]; then
  # Back up ONCE, and never back up our own wrapper. Re-running the installer used to
  # overwrite the genuine pre-lifeline launcher with a copy of the wrapper, leaving a
  # self-referential backup that uninstall would happily "restore".
  #
  # Refusing to overwrite is not enough on its own: anyone who re-ran an earlier installer
  # ALREADY has that poisoned backup, and nothing else would ever repair it. So a backup that
  # resolves to the wrapper is treated as absent.
  bak="${LIFELINE_HOME}/claude.pre-lifeline.bak"
  bak_target="$(readlink "${bak}" 2>/dev/null || true)"
  if [[ "${bak_target}" == *"claude-wrapper.sh" ]]; then
    rm -f "${bak}"
    warn "discarded a previous backup that pointed at lifeline's own wrapper"
  fi
  link_target="$(readlink "${CLAUDE_LINK}" 2>/dev/null || true)"
  if [[ ! -e "${bak}" && ! -L "${bak}" && "${link_target}" != *"claude-wrapper.sh" ]]; then
    cp -a "${CLAUDE_LINK}" "${bak}" 2>/dev/null || true
  fi
  rm -f "${CLAUDE_LINK}"
fi
ln -s "${LIFELINE_HOME}/claude-wrapper.sh" "${CLAUDE_LINK}"
say "repointed ${CLAUDE_LINK} -> lifeline wrapper (claude stays your command)"

# Put `lifeline` on PATH so `lifeline status` / `lifeline doctor` are real commands.
# dist/cli/index.js carries a node shebang, so a direct symlink runs it.
chmod +x "${SRC}/dist/cli/index.js" 2>/dev/null || true
ln -sf "${SRC}/dist/cli/index.js" "${LOCAL_BIN}/lifeline"
if ! command -v lifeline >/dev/null 2>&1; then
  warn "installed the 'lifeline' command to ${LOCAL_BIN}, which is not on your PATH."
  warn "add it with:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
fi

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

# --- the status window (menu-bar app) ----------------------------------------------
# Compiled locally with swiftc (lifeline's audience is developers, so the toolchain is
# effectively universal); skipped gracefully when absent — everything else still works.
if command -v swiftc >/dev/null 2>&1; then
  say "compiling the status window (menu-bar app)"
  mkdir -p "${LIFELINE_HOME}/bin"
  if swiftc -O -o "${LIFELINE_HOME}/bin/lifeline-menubar" "${SRC}/menubar/lifeline-menubar.swift" "${SRC}/menubar/TerminalRevealer.swift" 2>"${LIFELINE_HOME}/logs/menubar-build.log"; then
    plist="${LAUNCH_AGENTS}/com.lifeline.menubar.plist"
    render "${SRC}/install/com.lifeline.menubar.plist.tmpl" > "${plist}"
    launchctl bootout "gui/$(id -u)/com.lifeline.menubar" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "${plist}" >/dev/null 2>&1 || launchctl load "${plist}" >/dev/null 2>&1 || true
    say "loaded com.lifeline.menubar (look for the pulse in your menu bar)"
  else
    warn "status-window build failed (see ${LIFELINE_HOME}/logs/menubar-build.log); continuing without it"
  fi
else
  say "swiftc not found — skipping the menu-bar status window (everything else still works; install Xcode Command Line Tools and re-run to add it)"
fi

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
# Always remove-then-add so a moved checkout can never leave a stale registration behind.
"${CLAUDE_LINK}" mcp remove --scope user lifeline >/dev/null 2>&1 || true
"${CLAUDE_LINK}" mcp add --scope user lifeline -- "${NODE_BIN}" "${SRC}/dist/mcp/index.js" \
  >/dev/null 2>&1 && say "registered lifeline MCP server (user scope)" || \
  warn "could not register the MCP server automatically; run: claude mcp add --scope user lifeline -- ${NODE_BIN} ${SRC}/dist/mcp/index.js"

# --- done --------------------------------------------------------------------------
say "installed. Running a health check:"
"${NODE_BIN}" "${SRC}/dist/cli/index.js" doctor || true
cat <<EOF

lifeline is set up. Your command is still 'claude'.
  - restart any running 'claude' sessions so they route through lifeline (new ones already do)
  - status:  lifeline status
  - health:  lifeline doctor
  - remove:  uninstall from the menu-bar app (the ··· menu), or run:
             curl -fsSL https://raw.githubusercontent.com/fledgeling-co/claude-lifeline/main/uninstall.sh | bash
             (quitting the app does NOT remove the patch — uninstall does)

Note: if you set ANTHROPIC_API_KEY directly, claude bypasses the gateway and lifeline
can't heal transport errors on that path. 'lifeline doctor' will warn you if so.
EOF
