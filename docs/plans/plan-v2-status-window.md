# Plan: v2 status window (menu-bar app)

Spec: `docs/feature-specs/feature-v2-status-window.md`. Design reference:
`design/menubar/mock.html` (native popover grammar; question "is my work safe?";
signature = Recovery Pulse glyph + mint health strip; states: ideal/empty/daemon-quiet).

## Shape
The app is a THIN VIEW over existing seams. Zero daemon/gateway changes.
- Read: `~/.lifeline/status.json` (StatusSnapshot) — poll mtime every 1.5s + on popover open.
- Write: ControlIntent files to `~/.lifeline/intents/` (same shape + timestamp-first
  filename the CLI writes; daemon consumes on its next tick).

## Work items
1. `menubar/lifeline-menubar.swift` — single-file SwiftUI/AppKit hybrid:
   - `NSStatusItem` with a code-drawn pulse template image; tint amber on any
     warning/paused, red on whole-run failure, default otherwise. Tooltip = summary.
   - `NSPopover` hosting SwiftUI: header (title + online/quiet pill + summary + health
     strip), run rows (disclosure, dot, name, short id, state chip), agent rows (state
     vocabulary identical to the CLI renderer), contextual buttons (Retry on
     failed/paused agents; run-level Retry all failed / Pause / Resume), staleness
     banner >30s, empty state, footer (updated-ago + Quit).
   - Decodable structs mirroring StatusSnapshot/StatusAgent/StatusRun exactly; unknown
     states rendered dimly rather than crashing (forward compatibility).
   - `.accessory` activation policy (no Dock icon). Esc closes the popover (NSPopover
     default). Countdown text derives from nextRetryAt vs now, ticking locally.
2. `install/com.lifeline.menubar.plist.tmpl` — launchd agent (RunAtLoad, KeepAlive).
3. `install.sh` — compile step (swiftc -O to ~/.lifeline/bin/lifeline-menubar) when
   swiftc exists; load agent; plain note when absent. Both uninstallers remove it.
4. `src/cli/commands.ts` doctor — menubar row: ok (agent loaded) / note (skipped).
5. Evals:
   - `test/e2e/menubar-contract.test.ts`: (a) Swift-source vocabulary sync — every
     AgentState/RunState string in types.ts appears in the Swift switch; (b) an
     intent JSON in the exact shape the Swift app writes, dropped into the intents dir,
     is applied by a daemon tick (pause -> paused-manual; resume clears);
     (c) status fixture with warning-run renders states the Swift app switches on.
   - Build gate: `swiftc -typecheck` locally and in CI (macos runner already used).

## Order
swift app -> plist -> installer wiring -> doctor row -> evals -> local build + typecheck
-> suite green twice -> merge.
