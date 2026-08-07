# Revealing the controlling terminal — per-app mechanisms

Research (verified against installed apps where noted, Aug 2026) for the "open the terminal
tab running this workflow" feature. Goal: given the `claude` process PID that a workflow
run belongs to, raise the exact terminal window/tab/pane hosting it.

## Per-terminal capability

| Terminal | Focus exact tab/pane? | Mechanism | PID → pane mapping | Permission | Confidence |
|---|---|---|---|---|---|
| Terminal.app | Yes (tab-exact) | AppleScript: tab `tty` property; `set selected tab of window`, `frontmost`, `activate` | PID → controlling tty → match `tty of tab` | Automation (Apple Events TCC) | High (local sdef) |
| iTerm2 | Yes (session-exact) | AppleScript: session `tty`; `select` on session/tab/window (Python API also, but needs enabling) | PID → tty → match `tty of session` | Automation TCC | High |
| Ghostty ≥1.3.0 (2026-03) | Yes (tab/split), match indirect | AppleScript (on by default): `focus terminal`, `activate window`, `select tab` | No tty/pid exposed; match `name` (OSC-2 title) or `working directory` | Automation TCC | High (read installed 1.3.1 sdef) |
| WezTerm | Pane-exact in mux; OS-window raise best-effort | `wezterm cli list --format=json` (has `tty_name`) → `activate-pane --pane-id`; no `activate-window` (#3542) | PID → tty → match `tty_name` | None (unix socket) | High pane / Medium window |
| Kitty | Yes, if remote control pre-enabled | `kitten @ ls` → `kitten @ focus-window --match id:N` | `ls` JSON has `pid`/`foreground_processes` | None from macOS; user config required | High mechanism / Medium reachability |
| Alacritty | No | `alacritty msg` = create-window/config only; no list/focus; no sdef | Not possible via IPC; AX `AXTitle`+`AXRaise` only | Accessibility (AX) | High (not possible) |
| Warp | No (window at best) | No AppleScript (#3364); `warp://` only opens new things | Not possible; title = active tab only | Accessibility (AX) | High (not possible) |
| tmux (layer) | Yes (pane-exact in tmux) | `list-panes -a -F '#{pane_tty} …'` → `switch-client`/`select-window`/`select-pane`; then raise host terminal for the client tty | claude tty == `pane_tty`; recurse on `client_tty` | None for tmux | High |

## The universal first step: PID → controlling tty
Swift: `proc_pidinfo(pid, PROC_PIDTBSDINFO, …)` → `proc_bsdinfo.e_tdev` → `devname(e_tdev,
S_IFCHR)` = `ttys004` → `/dev/ttys004`. If the claude pid has no tty, walk parents
(`e_ppid`). A tty that matches a tmux `pane_tty` means the process is inside tmux; then use
the tmux **client** tty for the terminal-level search.

## Recommended lifeline strategy (`TerminalRevealer`)
1. Resolve tty by walking the PID's ancestry.
2. tmux layer first: if `tmux` exists and a pane matches, select it, then continue with the
   client tty.
3. Identify the hosting terminal (ancestry → responsible bundle id) and dispatch:
   - Terminal.app / iTerm2 → AppleScript tty-match (exact, zero-setup).
   - Ghostty → AppleScript `focus terminal`, matched by OSC-2 title `lifeline:<runId>`
     (set by lifeline's wrapper) or cwd; ≥1.3 only, else fallback.
   - WezTerm → `cli list` tty match → `activate-pane` → `NSWorkspace.activate`.
   - Kitty → probe known RC sockets; if reachable, `focus-window`; else fallback.
   - Warp / Alacritty / unknown → fallback.
4. Fallback: `NSRunningApplication.activate()` by bundle id; if Accessibility granted,
   AX-raise the window whose `AXTitle` carries the workflow marker/cwd.

Highest-leverage trick: lifeline's `claude` wrapper emits `\e]2;lifeline:<runId>\a` (OSC-2
title) when it starts claude. That makes Ghostty exact, gives Warp/Alacritty an AX handle,
and disambiguates multi-session cases; tty matching already makes Terminal.app, iTerm2,
WezTerm and tmux exact with no setup.

Permissions: AppleScript paths need `NSAppleEventsUsageDescription` + the per-target TCC
prompt (plus `com.apple.security.automation.apple-events` if hardened runtime). AX fallback
needs the Accessibility grant. CLI IPC (wezterm/kitty/tmux) needs none, but resolve binary
paths (often only under `/opt/homebrew/bin`), don't trust `PATH`.

Sources: ghostty.org/docs/features/applescript, ghostty 1.3.0 release notes, installed
Ghostty.sdef; iterm2.com/documentation-scripting.html; wezterm.org/cli/cli/activate-pane,
wezterm #3542, pane:get_tty_name; sw.kovidgoyal.net/kitty/remote-control, kitty #8191;
alacritty msg docs, alacritty #8282; Warp URI scheme docs, Warp #3364.
