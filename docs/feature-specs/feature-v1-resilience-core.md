# Feature: lifeline v1 — core resilience layer for Claude Code Workflows

This is the Phase-1 deliverable from `docs/plans/PLAN.md`. Read that plan and
`docs/research/*.md` for the full grounding. Scope below is deliberately the resilience
CORE; the control-plane UI and templating are later phases and are OUT of scope here.

## Goal
Stop Claude Code dynamic-workflow runs from silently losing agents to API errors. Deliver
automatic, persistent, class-aware recovery without modifying Anthropic's signed binary,
installable on macOS in one command, with a fault-injection eval harness proving it.

## Context (why)
Forensics over 1,054 local workflow runs: 646 (61%) lost ≥1 agent; 1,816/4,630 agents (39%)
died. The runtime returns `null` on any API error with zero retries; `.filter(Boolean)` drops
the loss; the run reports `completed`. Top causes: usage-limit (1,168), 429 (271),
ConnectionRefused (197), 5xx/overload, accounts-exhausted. The CLI (2.1.224) is a Bun-compiled,
code-signed, bytecode binary, so the workflow logic cannot be source-patched; lifeline works at
three external seams instead (gateway / journal-daemon / control-plane). v1 ships the gateway +
daemon + installer + evals.

## In scope (v1)

### A. `lifeline-gw` — transport retry gateway (Node 22 / TS, `undici`)
- Local HTTP gateway; Claude Code points at it via `ANTHROPIC_BASE_URL`; it forwards upstream
  (to `api.anthropic.com` or a user-configured `LIFELINE_UPSTREAM`, e.g. the user's existing
  multi-account proxy) and streams SSE back transparently.
- Error classifier (see plan §3 taxonomy): RATE_LIMIT (429/529), OVERLOADED (5xx/`overloaded_error`),
  CONN (ECONNREFUSED/RESET/ETIMEDOUT, truncated SSE), CONTEXT (`prompt too long` → terminal, pass
  through untouched), AUTH (400/401/403 → terminal).
- Retry within the downstream request: Full-Jitter backoff `rand(0, min(cap, base·2^attempt))`,
  base 1s, cap configurable (default 60s), honouring `Retry-After` verbatim when present. Retries
  here are BOUNDED by a per-request wall-clock budget (default 90s) so the CLI's own SDK
  (`max_retries=2`) doesn't itself time out; anything longer is escalated to the daemon as an
  agent-level failure, not held on the socket.
- On CONN with an offline probe failure (HEAD to a captive/`generate_204` endpoint), emit a
  connectivity-down event (file/socket) the daemon consumes; on probe success again, connectivity-up.
- Streaming correctness: never corrupt a partially-streamed SSE response; if a stream cuts
  mid-flight and no tokens are committed downstream, retry upstream; if tokens already flushed,
  surface as CONN failure (cannot un-send).
- Config via env / `~/.lifeline/config.json`: upstream, base, cap, per-request budget, max
  in-gateway attempts.

### B. `lifelined` — journal-watching recovery daemon (Node 22 / TS, `chokidar`)
- Watches `~/.claude/projects/*/*/subagents/workflows/wf_*/` (journal.jsonl + agent-*.jsonl +
  the sibling `<runId>.json` snapshot).
- Detects a lost agent: transcript ends in `apiError`, no matching `result` line in journal, no
  live controller (no write in the last N s). This is the silent-loss the run counted as done.
- Retry ledger: `~/.lifeline/ledger/<runId>.json`, records per prompt-chain key
  `{key, item, attempts, next_retry_at, last_class, state}` where state ∈
  `retrying | paused(offline|usage-limit|manual) | failed(terminal) | done`. Persisted; survives
  daemon restart. NOT written into journal.jsonl (keeps cache-prefix replay clean).
- Auto-recovery, cap 30 attempts, Full-Jitter backoff, `max_retry_duration` bound:
  - RATE_LIMIT/OVERLOADED/CONN that outlived the gateway → schedule relaunch.
  - USAGE_LIMIT / ACCOUNTS_EXHAUSTED → `paused(usage-limit)`, retry on a jittered schedule
    (backoff + connectivity/limit probe) so whichever proxy account frees first is picked up; do
    NOT hard-sleep to one parsed reset time.
  - CONTEXT → `failed(terminal)`, surfaced, never blind-retried.
  - connectivity-down event → set affected running items to `paused(offline)`; on connectivity-up,
    resume with per-agent jittered delay.
- Recovery mechanism for v1: relaunch a lost agent by re-invoking the workflow via its persisted
  script + `resumeFromRunId`, relocating the run dir into the current session first so the journal
  resolves (works around the session-id path bug, claude-code#65796). Before trusting any cached
  `MERGED`/completion, reconcile against git ancestry (not `--grep`). Serialise recoveries that
  touch the same repo.
- Idempotent: re-running recovery on an already-recovered item is a no-op. "Retry" == "Resume".
- Emits a machine-readable status file `~/.lifeline/status.json` (per run: agents, states, attempt
  counts) — this is what a later control-plane UI and `lifeline status` read.

### C. `lifeline` CLI (commander)
- `lifeline status` — human-readable view of runs/agents/states from status.json, using the
  research state vocabulary: per-agent `retrying(k/30, next Ns)` / `paused(reason)` /
  `failed(terminal)` / `done`; run-level `completed_with_failures` distinct from `completed`
  (a per-agent error while siblings run reads as a WARNING at run level, not an error).
- `lifeline retry <run|agent>` and `lifeline pause`/`lifeline resume <run|agent>` — manual
  controls that write intents the daemon honours (dispatch-gate model; pause stops new dispatch,
  optionally aborts in-flight; resume re-enables + triggers recovery).
- `lifeline doctor` — checks: gateway reachable, daemon running, `ANTHROPIC_BASE_URL` routed
  through the gateway (warn if a raw `ANTHROPIC_API_KEY` bypasses it), CLI version fingerprint
  status.

### D. Install / version-fingerprint (bash + node, launchd)
- `install.sh`: installs the three binaries + CLI into `~/.lifeline`, registers `lifelined` and
  the version-watcher as launchd agents, repoints `~/.local/bin/claude` to a transparent wrapper
  that exports `ANTHROPIC_BASE_URL=<gateway>`, ensures the daemon is up, and `exec`s the real
  signed binary (resolved from `~/.local/share/claude/versions/<current>`). Backs up the prior
  symlink. Idempotent; safe to re-run. Uninstall script restores the original launcher.
- Fail-closed fingerprint: `fingerprints/<version>.json` stores `{probe, sha256}` for the stable
  contracts (workflow tool JSON schema shape, journal.jsonl line shape, disk layout, base-url
  honouring). The launchd watcher fires when a new `versions/<ver>` appears, re-runs probes, and
  on drift writes an incompatibility flag + notifies (macOS notification + `lifeline doctor`
  surfaces it): "unsupported version X.Y.Z, lifeline running in reduced mode". Never mis-applies.

### E. Evals — fault-injection harness (vitest + fast-check + @sinonjs/fake-timers)
- Unit: classifier correctness on the real forensic signatures (fixtures drawn from the error
  taxonomy); backoff math (monotone ≤ cap, attempts ≤ cap+1, Retry-After overrides, jitter in
  bounds) via fast-check; `undici` MockAgent `.reply(429).times(n)` asserting the gateway makes
  exactly the expected retry sequence; fake-timers stepping past each backoff without real waits.
- Integration: a toxic Claude-compatible SSE mock server that replays seeded fault schedules
  modelling the top forensic scenarios (usage-limit, accounts-exhausted, 429 storm, offline blip,
  mid-stream cut). Golden assertions: no silent loss, ≤30 attempts, correct pause/resume,
  `completed_with_failures` surfaced, ledger persisted across a simulated daemon restart.
- Recovery e2e: synthesise a workflow run dir with injected `apiError` transcripts; assert the
  daemon detects the lost agent, schedules recovery, and reconciles against a git fixture.

## Out of scope (later phases, do NOT build here)
- Control-plane graphical/menubar UI, and enqueue/dequeue/message-agent queue mutation.
  (AMENDED 2026-08-07: a minimal MCP server DID move into v1 — status/retry/pause/resume
  tools with rich descriptions, registered by the installer — because "the CLI's model is
  aware of the new functionality" was an explicit v1 ask. Enqueue/templating tools remain
  later-phase.)
- Workflow templating.
- The npm/`node`-install `--require` source-rewrite deep-integration path.
- Any modification of the Claude Code binary.

## Acceptance criteria
1. With the gateway in front of a mock upstream that returns a 429 then 200, a forwarded request
   succeeds and the client never sees the 429; retry honoured `Retry-After`.
2. A synthesised workflow run with one `apiError`-terminated agent is detected as a lost agent by
   the daemon and driven to a recovery attempt; the ledger records the attempt and survives a
   daemon restart.
3. A usage-limit signature parks the agent as `paused(usage-limit)` and retries on a schedule
   without hard-sleeping to a single reset; a simulated account-free event resumes it.
4. `lifeline status` shows a run with one failed-but-recovering agent as run-level WARNING /
   `completed_with_failures`, not error.
5. `install.sh` on macOS repoints the launcher, starts the daemon, routes `claude` through the
   gateway, and is safe to run twice; `lifeline doctor` reports all green; uninstall restores the
   original launcher.
6. A simulated new CLI version whose contract probe fails is flagged as unsupported without
   mis-applying, and `lifeline doctor` surfaces it.
7. The eval harness runs green in CI and covers the top forensic scenarios.
8. `claude` continues to work exactly as before for a normal (non-failing) run, with the gateway
   and daemon transparent.
