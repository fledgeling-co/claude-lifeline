# lifeline — findings (forensics + CLI analysis)

## Decided (user, this session)
- **Name:** `lifeline`
- **Patch mode:** In-place + launchd watcher; plain `claude` stays the command; set-and-forget.
- **Limit policy:** 30-retry exponential backoff, THEN retry on reset. User runs a claude proxy across
  multiple accounts with *different* reset times, so a limit on one binding may clear when the proxy
  rotates — don't hard-sleep to a single reset. Also allow manual retry/resume.
- **Distribution:** Public GitHub under `lprhodes` + `curl … | bash`. Scaffold locally, confirm before push.
- **README copy:** must be written via `/create-luke-content:create-luke-content`.

## Forensics (1054 workflow runs scanned, all-time)
- 646/1054 runs had ≥1 failed agent. 1816 / 4630 agents failed (~39%).
- Error signature ranking (normalized):
  1. **session/usage limit — 1168** (by far the biggest killer; does NOT heal with backoff, resets at fixed time)
  2. Rate limited / "temporarily limiting requests" — 243 (+14 snap +14 snap variants) → 429-class
  3. ConnectionRefused — 102 (+95 snap) → local proxy/gateway restart, transport not model
  4. `API Error: N {…}` (5xx-class, N=status) — 93
  5. Prompt too long — 80 (snap) → context/token overflow, NOT retryable without compaction
  6. Connection closed mid-response — 62 (+49 snap) → partial stream, retryable
  7. "Server is temporarily limiting requests (not your usage limit)" — 49 → 429-class
  8. Autocompact thrashing — 37 (snap) → context refilled to limit
  9. Overloaded 5xx — 37 (+20 snap) → retryable
  10. `all accounts for binding are exhausted` / `all-accounts-exhausted` — 26+20 (snap) → PROXY multi-account exhaustion
  11. stalled no-progress — 16 (snap) → watchdog path (already has 5 retries)
  12. Internal server error 5xx — 9 (+3), server error mid-response, response stalled mid-stream
  13. worktree creation failure — 1
- Projects hit hardest: finance(127), perch(114), Dev-root(96), dAIolog(87), anvil(61), diolog-swe-bench(46), motif-terminal(40).

### Error taxonomy → policy (for retry classifier)
| class | examples | retryable | strategy |
|---|---|---|---|
| RATE_LIMIT (429) | "temporarily limiting requests", "Rate limited" | yes | expo backoff + jitter, up to 30 |
| USAGE_LIMIT | "session limit", "usage limit", "resets Xam" | yes-eventually | backoff loop; on exhaust, retry-on-reset; proxy may rotate accounts |
| ACCOUNTS_EXHAUSTED | "all accounts for binding are exhausted" | yes-eventually | same as usage limit (proxy-level) |
| OVERLOADED (5xx) | "Overloaded", "Internal server error", "Server error mid-response" | yes | expo backoff + jitter |
| CONN (transport) | "ConnectionRefused", "Connection closed mid-response", "stalled mid-stream" | yes | short backoff; auto-pause if connectivity down, resume when up |
| CONTEXT | "Prompt is too long", "Autocompact is thrashing" | NO (needs compaction) | do NOT blind-retry; surface / compact-then-retry |
| STALL | "no progress for Nms" | already 5 retries in watchdog | leave; feed classifier |

## CLI internals (v2.1.224)
- Install: native. `~/.local/bin/claude` → symlink → `~/.local/share/claude/versions/2.1.224`.
  Updater drops new `versions/<ver>` files (2.1.221..224 present, ~1/day).
- **The binary is a Bun standalone compiled Mach-O** (arm64, 265MB, hardened runtime, Developer-ID
  codesigned `com.anthropic.claude-code`). NOT a plain minified cli.js anymore.
  - JS embedded in Bun virtual FS (`$bunfs`), `cli.js` marker @ ~59.1MB, `// @bun` @ 55MB.
  - Bun trailer `---- Bun! ----` @ 276,739,737 (structured module graph, not inline text paths).
  - Anchors present in binary: resumeFromRunId(16), journal.jsonl(6), workflow_log(20), apiError(16),
    subagents(146), wf_(19).
- Toolchain available: system `bun 1.2.18`, `node v22.23.1`. (`claude-squad` via brew unrelated.)
- **Codesigning implication:** editing bytes in the signed binary invalidates the signature; arm64
  requires ≥ad-hoc valid sig to run. Options: (a) don't touch signed binary — repoint the user-owned
  `~/.local/bin/claude` symlink/shim to run a patched EXTRACTED cli.js on system bun; (b) byte-patch
  same-length + `codesign -f -s -` ad-hoc resign (can't ADD code, only swap equal-length → too small
  for new retry/pause logic); (c) full rebuild from extracted sources.
  → **Primary = (a) launcher-wrapper over untouched signed binary.** New logic can be arbitrary size.
  Feasibility risk = extracting cli.js + sibling assets (wasm/native) from the Bun 1.2.18 container and
  running standalone. THIS IS PHASE 0 SPIKE. Fallbacks (b)/(c) documented.

## Runtime mechanics (from workflow-resume/references/mechanics.md, confirmed relevant)
- API error path: `if (It.apiError){ push(`[${te}] failed: ${It.apiError}`); log; return null }` — **0 retries.**
- Existing retries: watchdog stall (5), throttle-gate (1, but rate-limits return too fast to qualify),
  StructuredOutput validation (5). None cover API errors.
- parallel()/pipeline() map null→null; `.filter(Boolean)` drops; run reports **completed**. Loss is silent.
- Journal path built from CURRENT session id → auto-compaction orphans journal (anthropics/claude-code#65796).
- Cache key = sha256 chain(prevKey, prompt, normalized opts{schema,model,effort,isolation,agentType});
  first miss is STICKY (replay is a prefix, not a set). Only non-null results journaled.
- TUI `r`(retry)/`x`(skip) only abort a LIVE AbortController; dead agent has none → can't revive. Missing
  state transition dead→live is the core UI gap.
- Disk layout: `<proj>/<SESSION>/workflows/<runId>.json` (snapshot), `.../scripts/<name>-<runId>.js`,
  `<proj>/<SESSION>/subagents/workflows/<runId>/journal.jsonl` + `agent-<id>.jsonl`.

## Feature set to build (from brief + analysis)
1. Auto-retry all retryable classes, expo backoff + jitter, cap 30, state persisted across process restart.
2. Retryable classifier per taxonomy above; CONTEXT/PROMPT-TOO-LONG excluded from blind retry.
3. Retry == Resume single UI action; clears red-cross on success; no-op-safe.
4. Error on one agent while siblings live → WARNING against workflow, not error. Error only when whole run fails.
5. Pause single agent OR whole workflow (pauses all subagents). Manual + auto.
6. Connectivity-aware auto-pause (offline detect) → auto-resume on reconnect.
7. Usage/limit + accounts-exhausted: backoff-loop then retry-on-reset; proxy multi-account aware.
8. Live queue mutation: enqueue / dequeue items into a running workflow; message specific agent (msg likely already possible).
9. Templating: extract reusable templates from common past workflows; reuse.
10. Tool descriptions updated so the CLI's own model knows the new capabilities.
11. Version-fingerprint incompatibility check: patched-version vs running-version; notify + (ideally) auto re-patch on update via watcher.
12. Evals: fault-injection / chaos harness for retry+recovery.
13. One-command macOS install (curl|bash): installs patcher + launchd watcher, applies patch, set-and-forget.

## CRITICAL UPDATE — 2.1.224 app code is Bun BYTECODE, not source
- Probing the JS region: readable source exists ONLY for Bun runtime internals (`@isObject`,
  `Bun.file(path).text()`, 306 `function X(`, 386 `await`). The APP/workflow logic is compiled to
  JSC bytecode: `apiError`, `journal.jsonl`, `toolUseID:"workflow_log"`, `resumeFromRunId` appear
  ONLY as interned string atoms surrounded by bytecode, not as `.apiError)` source (`\.apiError\)`
  count = 0). mechanics.md's readable minified JS was 2.1.220; Anthropic now ships `--bytecode`.
- ⇒ Regex/AST source patching of workflow logic is NOT viable and NOT update-robust (bytecode offsets
  shift every build). In-binary patching is the WRONG mechanism for the goal ("survive updates").

## CORRECTED ARCHITECTURE — sidecar over 3 stable seams (not binary patching)
Deliver ALL requested UX without touching Anthropic's signed bytecode, by intercepting at contracts
that are stable across versions:
- **Seam A — transport (HTTP to API).** A local retry-proxy on ANTHROPIC_BASE_URL path. Handles
  429 / 5xx / overload / connectivity: expo backoff + jitter, cap 30, connectivity auto-pause →
  auto-resume, and multi-account/usage-limit reset rotation (user already runs a multi-account
  proxy — integrate or chain). Update-proof: env var, no binary touch. Covers retry classes:
  RATE_LIMIT, OVERLOADED, CONN, and USAGE/ACCOUNTS via rotation.
- **Seam B — disk/state (journal dir).** A file-watching daemon on
  `<proj>/<session>/subagents/workflows/<runId>/`. Detects the silent agent losses (apiError→null→
  "completed"), maintains a retry-state ledger across process restarts, and drives agent-level
  recovery (relaunch/resume) that the proxy can't (e.g. a died agent). This is workflow-resume
  elevated to a live daemon. Depends on the on-disk contract, not internal identifiers.
- **Seam C — control/UX (MCP + skill + status surface).** New MCP server exposing enqueue / dequeue
  / pause(agent|workflow) / resume / message-agent / template-save / template-run — gives the CLI's
  model awareness via the MCP tool DESCRIPTIONS (satisfies "CLI aware of new functionality"). A
  `lifeline` status surface (menubar app or `lifeline status`/TUI) reframes red-cross→warning when
  siblings live, and offers manual Retry/Resume/Pause buttons (we can't repaint the built-in TUI,
  so this is the control panel).
- **The "patch" / "in-place + watcher":** install-time we repoint the user-owned
  `~/.local/bin/claude` → a transparent wrapper that (1) exports the proxy base-url + starts/attaches
  the daemon, (2) exec's the real signed binary untouched. `claude` stays the command; built-in
  workflow still runs, now enhanced. launchd watcher detects new `versions/<ver>`, re-fingerprints.
- **"diffs to keep patch up to date" / incompatibility check:** fingerprint each CLI version by the
  observable CONTRACT (workflow tool JSON schema, journal.jsonl line shape, disk layout). On a new
  version the watcher diffs the contract vs the last-verified one; only the thin adapters need
  updating if the contract moved, and the user is notified. Far less churn than per-build bytecode
  patches. This is the update-robust reading of "use diffs to keep the patch current."
- Fallbacks if a future goal truly needs in-binary behavior change: (b) same-length byte swap +
  `codesign -f -s -` ad-hoc resign (tiny edits only); (c) rebuild from a de-bytecoded source if
  Anthropic reverts. Documented, not primary.

NOTE: reconcile with user's "In-place + watcher" choice — the wrapper IS the in-place launch-path
edit + watcher; present the bytecode finding as WHY pure binary patching was avoided. Surface in plan.
