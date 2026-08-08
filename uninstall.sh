#!/usr/bin/env bash
#
# lifeline uninstaller — one line, restores everything to how it was.
#
#   curl -fsSL https://raw.githubusercontent.com/fledgeling-co/claude-lifeline/main/uninstall.sh | bash
#
# Self-contained: it reads what the installer recorded under ~/.lifeline, so it works
# whether you run it piped through curl or from a local checkout. Nothing needs to be
# made executable first.
#
set -euo pipefail

LIFELINE_HOME="${LIFELINE_HOME:-$HOME/.lifeline}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOCAL_BIN="$HOME/.local/bin"
CLAUDE_LINK="${LOCAL_BIN}/claude"

say() { printf '\033[36mlifeline\033[0m %s\n' "$*"; }

# --- stop and remove the launchd agents --------------------------------------------
for svc in gateway daemon watcher menubar; do
  launchctl bootout "gui/$(id -u)/com.lifeline.${svc}" >/dev/null 2>&1 || \
    launchctl unload "${LAUNCH_AGENTS}/com.lifeline.${svc}.plist" >/dev/null 2>&1 || true
  rm -f "${LAUNCH_AGENTS}/com.lifeline.${svc}.plist"
  say "removed com.lifeline.${svc}"
done

# --- restore ~/.claude/settings.json base URL (exact revert) ------------------------
RECORD="${LIFELINE_HOME}/settings-base-url.orig.json"
SETTINGS="$HOME/.claude/settings.json"
if [[ -f "${RECORD}" ]] && command -v node >/dev/null 2>&1 && [[ -f "${SETTINGS}" ]]; then
  # Prefer the installed patcher: it is the one implementation of this revert, and it writes
  # settings.json atomically. The inline copy below is the fallback for installs that predate
  # the patcher being copied into ${LIFELINE_HOME}.
  if [[ -f "${LIFELINE_HOME}/patch-settings.mjs" ]]; then
    restored="$(LIFELINE_HOME="${LIFELINE_HOME}" node "${LIFELINE_HOME}/patch-settings.mjs" revert 2>/dev/null || true)"
    say "settings.json base URL restored${restored:+ -> ${restored}}"
  else
    node -e '
    const fs = require("fs");
    const home = process.env.LIFELINE_HOME || (process.env.HOME + "/.lifeline");
    const settingsPath = process.env.HOME + "/.claude/settings.json";
    try {
      const rec = JSON.parse(fs.readFileSync(home + "/settings-base-url.orig.json", "utf8"));
      const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      s.env = s.env || {};
      if (rec.original === null || rec.original === undefined) delete s.env.ANTHROPIC_BASE_URL;
      else s.env.ANTHROPIC_BASE_URL = rec.original;
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
      process.stdout.write("settings.json base URL restored" + (rec.original ? " -> " + rec.original : " (removed)"));
    } catch (e) {}
  ' && echo
  fi
fi

# --- restore the real claude launcher ----------------------------------------------
# Restore to the NEWEST installed version, not to whatever was recorded: leaving someone on
# an old binary is the one outcome an uninstaller must not produce. The recorded path is
# used only when it points outside the versions directory (npm/homebrew installs).
CLAUDE_VERSIONS_DIR="${LIFELINE_CLAUDE_VERSIONS_DIR:-$HOME/.local/share/claude/versions}"
SETTLE_S="${LIFELINE_BINARY_SETTLE_S:-15}"
[[ "${SETTLE_S}" =~ ^[0-9]+$ ]] || SETTLE_S=15

file_mtime() {
  local m
  # GNU first: GNU `stat -f` means --file-system and SUCCEEDS while printing a literal `%m`,
  # so a BSD-first chain never reaches the `-c` fallback on Linux.
  m="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true)"
  [[ "${m}" =~ ^[0-9]+$ ]] || m=0
  printf '%s\n' "${m}"
}

# The newest version that has stopped changing. Uninstalling mid-update must not leave the
# user symlinked at a half-written 265MB download with no wrapper left to skip it.
newest_version_path() {
  local now candidate path
  [[ -d "${CLAUDE_VERSIONS_DIR}" ]] || return 1
  now="$(date +%s)"
  while IFS= read -r candidate; do
    path="${CLAUDE_VERSIONS_DIR}/${candidate}"
    # -f as well as -x: a directory is executable (searchable) too.
    [[ -n "${candidate}" && -f "${path}" && -x "${path}" ]] || continue
    if (( now - $(file_mtime "${path}") >= SETTLE_S )); then
      printf '%s\n' "${path}"
      return 0
    fi
  done < <(ls -1 "${CLAUDE_VERSIONS_DIR}" 2>/dev/null \
    | grep -E '^[0-9]+(\.[0-9]+)*$' \
    | sort -t. -k1,1nr -k2,2nr -k3,3nr -k4,4nr)
  return 1
}
# The reverse lives in each key spec, not a trailing `-r`: BSD sort ignores a global `-r`
# once the keys carry their own modifiers, which silently yields OLDEST-first.

real_target=""
recorded="$(cat "${LIFELINE_HOME}/real-claude" 2>/dev/null || true)"
if [[ -n "${recorded}" && "${recorded}" != "${CLAUDE_VERSIONS_DIR}/"* && -x "${recorded}" ]]; then
  real_target="${recorded}"          # non-standard install — the recorded path IS the binary
else
  real_target="$(newest_version_path || true)"
  [[ -z "${real_target}" && -n "${recorded}" && -x "${recorded}" ]] && real_target="${recorded}"
fi

if [[ -n "${real_target}" ]]; then
  rm -f "${CLAUDE_LINK}"
  ln -s "${real_target}" "${CLAUDE_LINK}"
  say "restored ${CLAUDE_LINK} -> ${real_target}"
elif [[ -e "${LIFELINE_HOME}/claude.pre-lifeline.bak" ]]; then
  rm -f "${CLAUDE_LINK}"
  cp -a "${LIFELINE_HOME}/claude.pre-lifeline.bak" "${CLAUDE_LINK}"
  say "restored ${CLAUDE_LINK} from backup"
else
  say "no recorded original launcher; leaving ${CLAUDE_LINK} as-is (check it points at your claude binary)"
fi

# --- remove the MCP registration ---------------------------------------------------
if [[ -x "${CLAUDE_LINK}" ]]; then
  "${CLAUDE_LINK}" mcp remove --scope user lifeline >/dev/null 2>&1 || true
fi

rm -f "${LIFELINE_HOME}/bin/lifeline-menubar"
[[ -L "${LOCAL_BIN}/lifeline" ]] && rm -f "${LOCAL_BIN}/lifeline"

say "lifeline removed. Your command is still 'claude'."
say "State under ${LIFELINE_HOME} is left in place; delete it with:  rm -rf ${LIFELINE_HOME}"
