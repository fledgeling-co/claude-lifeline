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
