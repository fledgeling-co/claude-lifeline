# Feature: lifeline status window (menu-bar app)

From the README roadmap: "A status window: a small menu-bar app showing your runs and
agents live, with clickable retry, pause and resume, so you're not reading it from the
terminal."

## Goal
A native macOS menu-bar app that makes lifeline's state glanceable and clickable. It is
the graphical face of the existing seams; it adds NO new state or logic of its own.

## Architecture constraints (fixed by the project)
- Reads `~/.lifeline/status.json` (StatusSnapshot, already written atomically by the
  daemon every tick). Watches/polls for changes; no daemon changes required.
- Actions write ControlIntent files to `~/.lifeline/intents/` in exactly the shape the
  daemon already consumes (`{id, kind: retry|pause|resume, target:{runId, agentId?},
  createdAt}`, timestamp-first filename). The app never touches ledgers or journals.
- Single-file SwiftUI app (`menubar/lifeline-menubar.swift`) compiled at install time
  with `swiftc` (the audience is developers; Xcode CLT is effectively universal).
  Installer skips it gracefully with a note when `swiftc` is absent. Runs as a launchd
  agent (`com.lifeline.menubar`), `LSUIElement` behaviour (no Dock icon) via
  NSApplication activation policy `.accessory`.
- No third-party Swift dependencies. macOS 14+ APIs acceptable (this machine: 26).

## In scope
0. **Install-consent / front-door (first run).** The app can be the entry point (installed
   standalone, e.g. a signed .app or Homebrew cask, as well as via the curl installer).
   On launch it detects whether the lifeline core (gateway + daemon) is present
   (`~/.lifeline/config.json` + a loaded `com.lifeline.daemon` agent, or a reachable
   gateway). If the core is ABSENT it shows a **setup screen instead of the normal
   popover** — never silently modifying the system, because installing repoints the
   user's `claude` launcher. The screen states plainly what will happen (three helpers;
   `claude` stays the command; Anthropic's app untouched; reversible), and one button
   runs the install, streaming narrated progress (helper started → watcher started →
   routing claude → fingerprint recorded → done) before transitioning to normal
   operation. The core genuinely being required is why setup appears on launch; consent
   (one click) is why nothing runs until the user chooses. Design ref: mock states
   `setup` / `installing`.
1. **Menu-bar item**: the Recovery Pulse motif at menu-bar scale (template-image pulse
   glyph). State-tinted: quiet when all healthy/idle, amber when any run is
   `warning`/`completed-with-failures` or any agent paused, red only when a whole run
   failed, blue-ish/animated optional for active recovery. Tooltip = one-line summary.
2. **Popover window** (NSPopover from the status item):
   - Header: lifeline title + overall health line + online/offline pill.
   - Run list: each tracked run with project name, run id (shortened), run-level state
     chip using the established vocabulary (`running / recovering / warning /
     completed / completed-with-failures`).
   - Expandable agents per run: item/agent id, state text exactly as the CLI renders it
     ("retrying (3/30, next in 12s)", "paused (usage limit)", "failed", "done"),
     with per-agent buttons: Retry, Pause/Resume (contextual).
   - Run-level buttons: Retry all failed · Pause run · Resume run.
   - Footer: "Open terminal status" (runs `lifeline status` in Terminal) optional;
     Quit item; staleness note when status.json is older than ~30s ("daemon quiet").
   - Empty state: "No workflows tracked yet" with one plain sentence.
3. **Live updates**: poll status.json mtime (1–2s) + reload on popover open. Countdown
   ("next in Ns") ticks locally between polls.
3b. **Tear-off window**: dragging the popover away from the menu bar detaches it into a
   real, resizable macOS window with the system's own detach animation — the native
   NSPopover detach mechanism (`popoverShouldDetach` + `detachableWindow(for:)`), never a
   custom drag reimplementation. The detached window: titled "lifeline", closable +
   resizable, min 360×420, shares the same live model (both surfaces stay current), and
   the content adapts to the wider/taller layout (mock stages 5–6). Closing it returns
   the app to popover behaviour on next click.
4. **Installer integration**: `install.sh` compiles the app when `swiftc` exists,
   installs the launchd agent, and reports; uninstall (both scripts) removes agent +
   binary. Idempotent re-install recompiles.
5. **Evals** (TS side, vitest — the app's contracts, not its pixels):
   - Intent-shape contract: a fixture of the Swift app's intent JSON parses as a valid
     ControlIntent and is accepted by the daemon's intent-apply path.
   - Status contract: the daemon's StatusSnapshot fixture covers every AgentState/
     RunState string the Swift source switches on (guards against vocabulary drift —
     grep the swift file for case strings and compare to types.ts).
   - Installer lint: bash -n; plist template placeholders all substituted.
   Plus a build smoke: `swiftc -typecheck` of the app in CI (macos runner) and locally.

## v2 additions (BUILT this iteration)
Design ref: `design/menubar/mock.html` (interactive) + `design/menubar/app-copy.md` (all UI
strings, written in Luke's voice, lint-clean — the app and mock both use these verbatim).
Implemented in the daemon (durations/context/stall/tail/caller from the real transcript
format), the Swift app, the wrapper, and the installer; covered by evals.

- **Per-row duration + context-window meter.** Each agent and run row shows its elapsed
  duration and a compact context-window-usage meter that warms (teal → amber → red) as
  the window fills. Data source: durations from journal `started`/last-activity
  timestamps; context usage from the transcript's latest usage record IF Claude Code
  writes token counts to `agent-*.jsonl` (verify the field at build; omit the meter
  gracefully if absent rather than faking it). Surfaced into `status.json` as
  `durationMs` + `contextFrac` per agent/run.
- **Stalled-agent detection.** A new AgentState `stalled`. The daemon flags an agent whose
  transcript has not grown AND whose context length hasn't changed for `stallWindowMs`
  (default **10 min**, configurable) while it is otherwise "running". A stall is a
  recoverable state, not a failure: the daemon nudges then relaunches (mirroring Claude
  Code's own 3-min watchdog but at a higher, lifeline-owned threshold), and the UI shows
  it as a warning with a hollow amber dot, not an error. Feeds the run-level `warning`
  rollup like any other attention state.
- **Transcript tail (progressive disclosure).** Each run shows one calm narrator line
  (its latest workflow-log line). Clicking an agent row reveals a recessed, scrollable
  mono panel of its last N transcript lines (errors highlighted). Collapsed by default to
  keep the resting view glanceable. `status.json` carries the last N lines per agent + the
  run's latest narrator line.
- **Reveal the controlling terminal.** A per-run action (hover-revealed icon) that raises
  the terminal window/tab running that workflow's `claude` session. Implementation from
  the terminal research (`docs/research/terminal-reveal.md`): resolve the claude PID →
  controlling tty (via `proc_pidinfo`), handle a tmux layer, then dispatch per terminal —
  AppleScript tty-match for Terminal.app/iTerm2 (exact, zero-setup); AppleScript
  title/cwd-match `focus terminal` for Ghostty ≥1.3; `wezterm cli activate-pane` by
  `tty_name`; kitty `@ focus-window` when remote control is on; tmux
  select-client/window/pane; and a generic `NSWorkspace.activate` by bundle id for
  Warp/Alacritty/unknown. The lifeline `claude` wrapper additionally emits an OSC-2 title
  (`lifeline:<runId>`) so Ghostty/Warp/Alacritty become title-matchable. Needs the
  Automation (Apple Events) TCC grant for the AppleScript paths; degrades to app-activate
  without it. **Never a hard requirement** — the button is best-effort and says so.
- **Install-consent front door** (spec item 0 above) with the narrated setup sequence.
- **`lifeline` on PATH.** The installer symlinks `lifeline` → `dist/cli/index.js` into
  `~/.local/bin` so `lifeline status` / `lifeline doctor` are real commands (warns if that
  dir isn't on PATH). Both uninstallers remove it.

## Out of scope
- Enqueue/dequeue/template UI (later; the popover links nowhere for these in v1).
- Notifications/alerts (macOS user notifications) — later phase.
- Windows/Linux anything.

## Acceptance criteria
1. `swiftc -typecheck` passes; the app builds at install and appears in the menu bar
   with no Dock icon.
2. With a synthesised status.json containing a warning run (one failed agent, siblings
   live), the menu-bar glyph tints amber and the popover shows the run as a warning
   with the failed agent's "failed" row and a Retry button.
3. Clicking Retry writes a ControlIntent file the daemon's existing intent parser
   accepts (verified by the contract eval against the same fixture shape).
4. Pause on a run writes a run-scoped intent (no agentId); Resume likewise.
5. Popover reflects a status.json change within 2s without reopening.
6. status.json older than 30s shows the "daemon quiet" note rather than stale data
   presented as live.
7. Installer with swiftc present: compiles, loads `com.lifeline.menubar`, idempotent on
   re-run. Without swiftc: prints a plain note and everything else still installs.
   Uninstall removes the agent + binary and the menu-bar item disappears.
8. All existing evals stay green; new contract evals green in the same suite.
9. `lifeline doctor` gains a menubar row: ok when the agent is loaded, plain note when
   skipped (no swiftc), never a hard failure.
10. Dragging the popover detaches it into a titled, resizable window (system detach
   animation); the window keeps updating live; closing it restores popover behaviour.
