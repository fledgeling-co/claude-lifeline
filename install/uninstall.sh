#!/usr/bin/env bash
#
# lifeline uninstaller — restores your original claude launcher and removes the agents.
#
set -euo pipefail

LIFELINE_HOME="${LIFELINE_HOME:-$HOME/.lifeline}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOCAL_BIN="$HOME/.local/bin"
CLAUDE_LINK="${LOCAL_BIN}/claude"

say() { printf '\033[36mlifeline\033[0m %s\n' "$*"; }

for svc in gateway daemon watcher; do
  launchctl bootout "gui/$(id -u)/com.lifeline.${svc}" >/dev/null 2>&1 || \
    launchctl unload "${LAUNCH_AGENTS}/com.lifeline.${svc}.plist" >/dev/null 2>&1 || true
  rm -f "${LAUNCH_AGENTS}/com.lifeline.${svc}.plist"
  say "removed com.lifeline.${svc}"
done

# Restore the settings.json base URL captured at install time (exact revert).
if [[ -f "${LIFELINE_HOME}/settings-base-url.orig.json" ]] && command -v node >/dev/null 2>&1; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  restored="$(LIFELINE_HOME="${LIFELINE_HOME}" node "${SCRIPT_DIR}/patch-settings.mjs" revert || true)"
  say "restored settings.json base URL${restored:+ -> ${restored}}"
fi

# Restore the real claude launcher.
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

say "lifeline services removed. State under ${LIFELINE_HOME} is left in place; delete it to fully clean up."
