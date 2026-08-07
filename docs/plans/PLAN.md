# lifeline — Implementation Plan

> A resilience & recovery layer for the Claude Code CLI's Workflow feature.
> Written 2026-08-07 from (a) forensics over 1,054 local workflow runs, (b) a 4-backend
> Dossier deep-research panel (125 sources / 36 domains), (c) direct analysis of the
> installed CLI binary (`2.1.224`). Sources: `docs/research/*.md`, scratch `FINDINGS.md`.

---

## 1. Why this exists (the evidence)

Forensics over every dynamic-workflow run on this machine:

- **646 / 1,054 runs (61%) lost at least one agent.** **1,816 / 4,630 agents (39%) died.**
- Cause ranking (normalised): session/usage-limit **1,168**; rate-limit (429-class) **271**;
  ConnectionRefused **197**; 5xx/`{status}` **~110**; prompt-too-long/autocompact **117**;
  connection-closed-mid-response **111**; overloaded **57**; `all-accounts-exhausted` (the
  user's multi-account proxy) **46**; worktree-create **1**.
- The runtime treats **every** API error as terminal for the agent: `if (It.apiError) return null`
  — **0 retries**. `parallel()`/`pipeline()` map `null→null`, the script's `.filter(Boolean)`
  drops it, and the run reports **`completed`**. The loss is silent. (Confirmed in
  `workflow-resume/references/mechanics.md`, still true in 2.1.224.)

The existing `workflow-resume` skill is a *post-mortem* tool — it scans journals after the fact
and hands back a resume call. lifeline makes recovery **live, automatic, and visible**.

## 2. The constraint that shapes everything: the CLI is a Bun-bytecode binary

Direct inspection of `~/.local/share/claude/versions/2.1.224`:

- It is a **Bun standalone, code-signed Mach-O** (arm64, 265 MB, hardened runtime,
  `com.anthropic.claude-code`), installed native (`~/.local/bin/claude` → `versions/<ver>`),
  auto-updated ~daily.
- The **app/workflow JS is compiled to JSC bytecode**. `workflowProgress`, `workflow_agent`,
  `agentControllers`, `journal.jsonl`, `resumeFromRunId` survive only as **interned string
  atoms inside bytecode** — never as readable source (`\.apiError\)` source count = 0). The
  readable JS in the binary is Bun's own runtime, not the app. (2.1.220 was readable minified
  JS; Anthropic switched to `--bytecode` since.)

**Consequence (decisive):** regex/AST **source-patching of the workflow logic is not viable**
on the native install, and byte-level bytecode patching is the *opposite* of update-robust
(offsets move every build) and breaks the code signature. Deep-research ranked patch durability
and reached the same verdict — network-layer injection is release-proof; in-memory source
rewrite (`NODE_OPTIONS --require` + `Module._compile` hook, Vencord-grammar anchors) is the
recommended *code-layer* mechanism **but only reaches a `node cli.js` install, not a Bun binary**;
disk/binary patching (tweakcc's `node-lief` extract/repack) is overwritten every update.

→ **lifeline never modifies Anthropic's signed binary.** It intercepts at three contracts that
are stable across releases.

## 3. Architecture — a sidecar over three stable seams

```
        ┌─────────────────────────── lifeline ───────────────────────────┐
        │                                                                 │
  claude (unchanged, signed)                                              │
     │        │  spawns workflow agents (in-process, Anthropic code)      │
     │        ▼                                                           │
     │   journal.jsonl / agent-*.jsonl / <runId>.json  ◀── Seam B ────────┤ lifelined (daemon)
     │        (on-disk workflow state contract)          watch+recover    │  · retry ledger
     │                                                                    │  · relaunch/resume
     ▼ HTTP (ANTHROPIC_BASE_URL)                                          │  · red✗→warning reframe
  Seam A: lifeline-gw  ──▶  [user's multi-account proxy]  ──▶  api.anthropic.com
     transport retry: 429 / 5xx / overloaded / conn         (fast, bounded by client timeout)
     connectivity probe → offline signal ─────────────────────────────────┤
                                                                          │
  Seam C: lifeline MCP server + `lifeline` CLI/menubar                    │
     enqueue · dequeue · pause(agent|wf) · resume · retry · message ·     │
     template save/run · status  (model-facing tool descriptions)         │
        └─────────────────────────────────────────────────────────────────┘

  Install seam: ~/.local/bin/claude → lifeline wrapper (repoints user-owned symlink):
     exports ANTHROPIC_BASE_URL=lifeline-gw, ensures lifelined running, exec's real binary.
  launchd watcher: on new versions/<ver>, re-fingerprint the contract (fail-closed).
```

### Seam A — `lifeline-gw` (transport retry proxy)
Local HTTP gateway on `ANTHROPIC_BASE_URL`; chains to the user's existing multi-account proxy
(does not replace it). Owns retries the transport can heal **within the client's request timeout**:

| class | detect | action |
|---|---|---|
| RATE_LIMIT 429 / 529 | status / `Retry-After` | honor `Retry-After` verbatim; else Full-Jitter backoff |
| OVERLOADED 5xx | status / `overloaded_error` | Full-Jitter backoff |
| CONN (ECONNREFUSED/RESET/ETIMEDOUT, truncated SSE) | socket/stream | short backoff; emit **connectivity signal** to Seam B |
| CONTEXT (`prompt too long`) | status/body | **terminal** — never blind-retry (pass through) |
| AUTH 400/401/403 | status | terminal (pass through) |

- **Full Jitter** (AWS Brooker): `sleep = rand(0, min(cap, base·2^attempt))`, base 1s, cap 60s.
- **Bounded by the downstream client timeout** — the gateway holds the CC request open while
  retrying upstream, so per-request retries are *fast* (seconds). Long recovery (usage-limit,
  30× over 30–60 min) is **not** done by holding the socket — it belongs to Seam B.
- **Anti-stacking:** Anthropic's own in-CLI SDK retries (`max_retries=2`) wrap the gateway; the
  gateway must return promptly enough that the SDK doesn't itself time out and double-count.
- **Sharp edges (from research):** a stray `ANTHROPIC_API_KEY` bypasses the gateway (installer
  warns/guards); if we ever embed LiteLLM, pin a non-malware version (1.82.7/8 shipped malware).

### Seam B — `lifelined` (journal-watching recovery daemon)
Watches `~/.claude/projects/*/*/subagents/workflows/wf_*/`. This is where the silent-loss bug
and the 30-retry / usage-limit recovery live.

- **Retry ledger** (the persistence model, from DBOS/Temporal): a *separate* mutable-state file
  keyed by the same sha256 prompt-chain — `{key, attempts, next_retry_at, last_class, state}` —
  **not** journal `result` entries, so cache-prefix replay stays clean and history isn't
  polluted. Survives process restart.
- **Silent-loss detection:** an agent whose transcript ends in `apiError` with no `result` line
  and no live controller = a lost agent the run counted as done.
- **Auto-recovery, cap 30, per class:**
  - RATE_LIMIT/OVERLOADED/CONN that outlived the gateway → schedule agent relaunch with
    Full-Jitter backoff (agent-level, via a lifeline-managed re-dispatch, not a socket hold).
  - USAGE_LIMIT / ACCOUNTS_EXHAUSTED → **`paused(usage-limit)`**, not a hot loop. Because the
    user runs multiple accounts with *different* resets, lifeline retries on a schedule
    (backoff + probe) so a proxy account rotation is picked up as soon as *any* binding frees —
    it does **not** hard-sleep to one reset time. Manual retry/resume always available.
  - CONTEXT/PROMPT-TOO-LONG → surfaced, not blind-retried (optional compact-then-retry later).
- **Duration bound:** 30 attempts at cap ≈ 30–60 min; ledger also carries a `max_retry_duration`
  so a truly dead binding parks rather than churns.
- **Reconciliation before trusting a cached `MERGED`** (carried over from workflow-resume): git
  ancestry check, not `--grep`.
- **Resume correctness:** relocates the run dir into the current session before a fresh resume
  so the journal resolves (works around anthropics/claude-code#65796, session-id path bug).

### Seam C — control plane (`lifeline` CLI + MCP server + status surface)
- **MCP server** exposing, with rich tool **descriptions so the CLI's own model knows the new
  capabilities**: `lifeline_enqueue`, `lifeline_dequeue`, `lifeline_pause`(agent|workflow),
  `lifeline_resume`, `lifeline_retry` (retry == resume; idempotent/no-op-safe), `lifeline_message`
  (to a specific agent — deliver at step boundary), `lifeline_template_save`,
  `lifeline_template_run`, `lifeline_status`.
- **Queue mutation (mailbox model, from Temporal Signals/Updates + actor mailboxes):** append
  items (new sha256 keys → no replay conflict), cancel *pending* items (mark-skipped before
  dispatch), reprioritize. **Cannot**: rewrite an already-journaled prompt-chain (breaks the
  cache invariant) or yank an in-flight agent without abort. For lifeline-authored templated
  workflows the running script drains a mailbox file between ticks (full live mutation); for
  built-in runs, enqueue = daemon spawns an adjunct agent (best-effort). Stated honestly.
- **Status surface** — a `lifeline status` TUI + optional menubar app. This is where the
  **red-✗ → ⚠ warning** reframe lives: **agent error while siblings still run → workflow shows
  WARNING; error only when the whole run fails.** Manual **Retry / Resume / Pause** buttons.
  State vocabulary (from GitHub Actions / CircleCI / Prefect / Buildkite): per-agent
  `retrying(k/30, next Ns)` · `paused(offline|usage-limit|manual)` · `failed(terminal)`;
  run-level `completed_with_failures` distinct from `completed`. (We can't repaint the built-in
  TUI's own glyphs on the Bun binary, so lifeline's surface is the authoritative control panel;
  a `node`-install deep-integration path can additionally recolor the TUI — see §5.)
- **Templating:** the Workflow runtime already separates `script` + `args` + literal `meta`.
  Template = saved script + an inferred JSON-schema for `args` (defaults = the run's literals,
  types via schema-infer). lifeline scans `~/.claude/projects/*/*/workflows/scripts/*.js`,
  clusters by `meta.name`/shape, surfaces reusable templates; `template_run(name, args)`
  instantiates. (Argo `WorkflowTemplate` registry + Temporal single-object-arg stability.)

### Install / update seam
- One-command macOS installer (`curl … | bash`): installs `lifeline-gw`, `lifelined`, the MCP
  server (registers in `~/.claude`), the `lifeline` CLI, the launchd watcher; repoints
  `~/.local/bin/claude` → transparent wrapper; sets `ANTHROPIC_BASE_URL`. `claude` stays the
  command. **Set and forget.**
- **Fail-closed version fingerprinting** (Atlas `atlas.sum` model): per stable contract
  (workflow tool JSON schema, `journal.jsonl` line shape, disk layout, base-url honoring) store
  `{probe, sha256}`. launchd watcher fires on a new `versions/<ver>`; re-runs probes; on drift →
  notify "unsupported version X.Y.Z — lifeline running in reduced/unpatched mode," **never
  mis-apply**. A GitHub Action re-validates against each published `@anthropic-ai/claude-code`
  release so breakage is caught before users hit it. This is the "diffs to keep the patch
  current" requirement, done at the contract level (far less churn than per-build patches).

## 4. Feature → requirement traceability (from the brief)

| # | User ask | Seam | Notes |
|---|---|---|---|
| 1 | auto-retry all cases, expo backoff, cap 30, survive restart | A+B | Full Jitter; ledger persisted |
| 2 | classify retryable vs terminal | A+B | taxonomy §3; CONTEXT excluded |
| 3 | Retry == Resume, one action, clears red-✗ | B+C | idempotent, no-op-safe |
| 4 | sibling error → warning not error | C | `completed_with_failures` |
| 5 | pause single agent OR whole workflow | C | dispatch-gate; manual+auto |
| 6 | connectivity auto-pause → auto-resume | A→B | active probe; jittered resume |
| 7 | usage-limit + accounts-exhausted recovery | B | pause + scheduled retry, proxy-aware |
| 8 | enqueue / dequeue / message agent | C | mailbox; step-boundary delivery |
| 9 | template common workflows, reuse | C | script+args schema infer |
| 10 | CLI aware of new functionality | C | MCP tool descriptions |
| 11 | version-incompat check + auto re-patch | install | fail-closed fingerprint + watcher |
| 12 | evals | §6 | fault-injection harness |
| 13 | one-command macOS install, set-and-forget | install | curl\|bash + launchd |

## 5. Install topologies (honesty about reach)
- **Native Bun install (this user, default):** retry via Seam A gateway; recovery via Seam B
  daemon; control via Seam C. In-binary UI recolor unavailable → lifeline's own status surface
  is the control panel. This is the supported v1 path.
- **npm/`node cli.js` install (advanced, optional):** additionally offer a `NODE_OPTIONS
  --require` source-rewrite shim (Vencord-grammar, fingerprint-gated) that can recolor the
  built-in TUI and add a dispatch-gate in-process. Behind a flag; not required for any core
  feature.

## 6. Evals (fault-injection harness — a genuine contribution)
Research found **no** tool provides seeded, deterministic fault schedules across LLM calls +
orchestrator retries. lifeline ships one:
- **Unit:** `@sinonjs/fake-timers` `clock.tickAsync` (steps past each backoff without real
  waits); `undici` `MockAgent` `.reply(429).times(n)` asserting `timesInvoked` == expected retry
  count; Retry-After honored.
- **Property-based:** `fast-check` `fc.scheduler()` over (base, mult, cap, maxRetries, failure
  sequence of 429/500/ECONNRESET/timeout) — invariants: delay monotone ≤ cap, attempts ≤ cap+1,
  `Retry-After` overrides computed backoff, jitter in bounds.
- **Integration / chaos:** a **toxic Claude-compatible SSE mock** (llmock-style one-shot 429/503
  + `Toxiproxy limit_data` for truncated-SSE = "connection closed mid-response", `latency`,
  `reset_peer` = ConnectionRefused) driven by a **seeded fault schedule modeling lifeline's own
  error taxonomy**. Golden scenarios replay the top forensic signatures (usage-limit,
  accounts-exhausted, 429 storm, offline blip, mid-stream cut) and assert: no silent loss, ≤30
  attempts, correct pause/resume, `completed_with_failures` surfaced.
- **Recovery e2e:** simulated workflow run dir + injected `apiError` transcripts → assert the
  daemon detects, relaunches, and reconciles against git.

## 7. Phased delivery (feeds /ship-feature)
- **Phase 0 — feasibility spike (gate):** confirm CC honors a local `ANTHROPIC_BASE_URL` end to
  end for workflow agents; confirm the wrapper repoint + launchd watcher; confirm journal
  contract fingerprints are stable across 2.1.221→224. If a seam is blocked, adjust before build.
- **Phase 1 — core resilience (v1, the /ship-feature deliverable):** Seam A gateway (retry +
  connectivity signal) + Seam B daemon (ledger, silent-loss detection, auto-retry cap 30,
  usage-limit pause/scheduled-retry, resume-correctness) + fail-closed fingerprint + one-command
  installer + eval harness. This alone kills the top-3 forensic failure modes.
- **Phase 2 — control plane:** MCP server (enqueue/dequeue/pause/resume/retry/message) + `lifeline
  status` TUI + red-✗→warning reframe.
- **Phase 3 — templating + menubar + npm deep-integration path.**

## 8. Stack
Node 22 / TypeScript (matches CC's runtime; SDK-compat mocks are Node-native). `undici` for the
gateway, `chokidar` for journal watching, `commander` for the CLI, `@modelcontextprotocol/sdk`
for Seam C, `listr2` (status/degradation rendering) + `offline-detector`/`is-online` (connectivity),
`vitest` + `fast-check` + `@sinonjs/fake-timers` for evals. launchd plist for the watcher. Install
script pure bash + node; no Homebrew formula required for v1 (curl|bash).

**Build-not-buy (corroborated by all backends):** do NOT adopt Temporal/Restate as an engine —
mandating PostgreSQL + a daemon cluster on end-users to run a local coding agent is an unacceptable
operational burden. Build a lightweight embedded checkpointer over the *existing* `journal.jsonl`
(event-sourcing borrowed from Restate/DBOS, backoff state machine borrowed from the retry tables),
preserving CC's zero-config nature. lifeline adds a small daemon + gateway, not an orchestration
platform.

## 9. Open risks
- CC may not route workflow-agent HTTP through `ANTHROPIC_BASE_URL` identically to the main loop
  (Phase 0 gate).
- Agent-level relaunch for a *built-in* workflow may require driving `claude --resume` rather than
  in-process re-dispatch — acceptable, but shapes Seam B's recovery UX.
- Fingerprint anchors decay (~25 minor versions per tweakcc history) — mitigated by CI-per-release
  + contract-level (not code-level) probes.
