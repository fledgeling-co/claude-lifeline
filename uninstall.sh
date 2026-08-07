#!/usr/bin/env bash
#
# lifeline uninstaller — one line, restores everything to how it was.
#
#   curl -fsSL https://raw.githubusercontent.com/lprhodes/lifeline/main/uninstall.sh | bash
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
for svc in gateway daemon watcher; do
  launchctl bootout "gui/$(id -u)/com.lifeline.${svc}" >/dev/null 2>&1 || \
    launchctl unload "${LAUNCH_AGENTS}/com.lifeline.${svc}.plist" >/dev/null 2>&1 || true
  rm -f "${LAUNCH_AGENTS}/com.lifeline.${svc}.plist"
  say "removed com.lifeline.${svc}"
done

# --- restore ~/.claude/settings.json base URL (exact revert) ------------------------
RECORD="${LIFELINE_HOME}/settings-base-url.orig.json"
SETTINGS="$HOME/.claude/settings.json"
if [[ -f "${RECORD}" ]] && command -v node >/dev/null 2>&1 && [[ -f "${SETTINGS}" ]]; then
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

# --- restore the real claude launcher ----------------------------------------------
if [[ -f "${LIFELINE_HOME}/real-claude" ]]; then
  real_target="$(cat "${LIFELINE_HOME}/real-claude")"
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

say "lifeline removed. Your command is still 'claude'."
say "State under ${LIFELINE_HOME} is left in place; delete it with:  rm -rf ${LIFELINE_HOME}"
