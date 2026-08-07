---
title: "Durable retry patterns for embedded multi-agent CLI runtimes"
run_id: dr_690ca4ad67253967
question: "Resilience and recoverability patterns in agentic workflow orchestration systems (2024-2026), to inform hardening a local multi-agent workflow runtime embedded in a CLI (Claude Code's Workflow tool). The runtime today: fans out LLM subagents via parallel()/pipeline() JS scripts, journals results append-only (journal.jsonl keyed by sha256 prompt-chain), replays a cache prefix on resume, and treats any API error (HTTP 429 rate limit, usage limit, 5xx overload, ConnectionRefused) as terminal for the agent with zero retries — the agent returns null and the run reports 'completed'. Research: (1) retry/backoff design in comparable durable-execution and agent-orchestration systems — Temporal, Restate, DBOS, Inngest, Prefect, Airflow, LangGraph checkpointing, Mastra, CrewAI, AutoGen, claude-flow, OpenAI Agents SDK — specifically exponential backoff policies, retry caps, jitter, error classification (retryable vs terminal), and how retry state is persisted across process restarts; (2) pause/resume semantics: pausing a single task vs a whole workflow, connectivity-aware auto-pause (offline detection) and auto-resume, and how UIs represent paused/degraded/failed states (error vs warning when siblings still run); (3) live queue mutation: adding/removing work items to a running workflow without restarting it, and message-passing to running agents; (4) workflow templating: extracting reusable templates from ad-hoc workflow definitions; (5) techniques for maintaining a patch against a frequently-updated minified single-file JS bundle: patch-package, ASAR patching, monkey-patching via module interception (NODE_OPTIONS --require), binary diff/fuzzy patching, AST-based transforms that survive identifier renames, version fingerprinting for incompatibility detection; (6) eval/testing approaches for retry and recovery logic (fault injection, chaos testing for agent pipelines). Deliver concrete mechanisms and API/config shapes, not marketing summaries."
provider: openai
model: gpt-5.6-terra
tier: fast
archetype: technical
sources: 77
tools: [google_search, url_context, code_execution]
estimated_cost_usd: 3.50
completed: 2026-08-07T07:36:21.740Z
---
## Executive Summary

- **(High Confidence)** The current runtime’s “API error → `null` → workflow completed” behavior is a correctness defect, not merely a UX gap: durable systems persist a failed attempt and retry schedule at a *step/node boundary*; they do not convert an unperformed required unit of work into success. Inngest persists completed step results and retries only the failed step; DBOS resumes at the last completed step; LangGraph persists pending writes and failure provenance. [Inngest official error-handling documentation](https://www.inngest.com/docs/guides/error-handling) ([inngest.com](https://www.inngest.com/docs/guides/error-handling?utm_source=openai)) [DBOS official workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) ([docs.dbos.dev](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial?utm_source=openai)) [LangGraph official persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/persistence?utm_source=openai))

- **(High Confidence)** Implement retries at the individual agent invocation / external-call boundary, not around an entire `parallel()` or `pipeline()` script. Use **30 retries plus the initial attempt = 31 maximum attempts**, persisted after every failure, with capped exponential backoff and full jitter. This matches the granular durable-execution pattern used by Inngest, DBOS, Temporal, and LangGraph, while avoiding replay of successful siblings. [Inngest official retry documentation](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries) ([inngest.com](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries?utm_source=openai)) [DBOS official workflow/step reference](https://docs.dbos.dev/typescript/reference/workflows-steps) ([docs.dbos.dev](https://docs.dbos.dev/typescript/reference/workflows-steps?utm_source=openai)) [Temporal protocol/API documentation](https://api-docs.temporal.io/) ([api-docs.temporal.io](https://api-docs.temporal.io/?utm_source=openai)) [LangGraph official fault-tolerance documentation](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/fault-tolerance?utm_source=openai))

- **(High Confidence)** Classify usage-limit / quota exhaustion differently from transient 429s and 5xxs: honor `Retry-After` for ordinary throttling; for a known account-usage reset, transition the affected agent to `PAUSED_USAGE_LIMIT` and schedule resume at the reset time rather than burning 30 attempts. Restate’s deliberate “pause after retry exhaustion, then manual/UI resume” model is the closest reference pattern. [Restate official service-configuration reference](https://docs.restate.dev/services/configuration) ([docs.restate.dev](https://docs.restate.dev/services/configuration?utm_source=openai)) [Restate official invocation-management documentation](https://docs.restate.dev/services/invocation/managing-invocations) ([docs.restate.dev](https://docs.restate.dev/services/invocation/managing-invocations?utm_source=openai))

- **(High Confidence)** Represent workflow control and health separately. A workflow with siblings still running while one child is backing off or paused should be `RUNNING + DEGRADED`, not failed and not completed. A required child that permanently exhausts retries must make the workflow `FAILED`; optional children may produce an explicit `SUCCEEDED_WITH_WARNINGS`, never silent `null` success. <INFERENCE from="https://www.inngest.com/docs/guides/error-handling, https://docs.langchain.com/oss/python/langgraph/fault-tolerance, https://docs.restate.dev/services/invocation/managing-invocations">These systems distinguish retriable errors, exhausted failures, and pause/resume states; the proposed local state model applies that distinction to parallel CLI agents.</INFERENCE>

- **(High Confidence)** Choose a **version-gated AST transform plus external launcher/sidecar**, not `patch-package`, a binary diff, or unconditional fuzzy text replacement. The installer should fingerprint the vendor bundle, parse it, require unique semantic anchors, apply an idempotent AST transform atomically, verify behavioral probes, and fail closed on an unknown version. `NODE_OPTIONS=--require` module interception is a useful *delivery optimization* only after a probe proves that the target is an ordinary Node CommonJS load path; it is not a universal mechanism for packaged or single-executable CLIs. [Node.js command-line documentation for NODE_OPTIONS and --require](https://nodejs.org/api/cli.html) ([nodejs.org](https://nodejs.org/api/cli.html?utm_source=openai)) [jscodeshift official repository/documentation](https://github.com/facebook/jscodeshift) ([github.com](https://github.com/facebook/jscodeshift?utm_source=openai))

- **(Medium Confidence)** Do not build a full local Temporal/Restate equivalent for this embedded macOS CLI. Build a small sidecar scheduler backed by SQLite and an append-only event journal, but adopt durable-engine semantics: persisted attempts, stable next-at timestamps, command idempotency, explicit pause reasons, mailbox messages, and checkpointed queue mutations. <INFERENCE from="https://docs.restate.dev/services/configuration, https://docs.dbos.dev/architecture, https://www.inngest.com/docs/learn/how-functions-are-executed">The recommended design captures the recovery primitives documented by durable engines without introducing their server/control-plane operational footprint.</INFERENCE>

- **(High Confidence)** The evaluation gate should be fault injection, not happy-path testing: scripted 429/5xx/usage-limit responses, process termination at every persistence boundary, stale-lock recovery, clock-controlled backoff tests, and network impairment through Toxiproxy. Toxiproxy supports latency, connection resets, timeouts, bandwidth limits, and packet loss for deterministic and randomized resilience tests. [Shopify Toxiproxy official repository](https://github.com/Shopify/toxiproxy) ([github.com](https://github.com/shopify/toxiproxy?utm_source=openai))

---

## Detailed Findings

### 1. Resilience and recoverability patterns in agentic workflow orchestration systems (2024-2026), to inform hardening a local multi-agent workflow runtime embedded in a CLI

### 1.1 Decision: the correct recovery unit is a durable agent-step, not the overall script

**(High Confidence)** The patch should treat each LLM subagent invocation, model call, or externally side-effecting tool operation as a persisted unit with an identity:

```ts
stepKey = sha256(
  runId +
  workflowPlanRevision +
  agentId +
  promptChainDigest +
  modelConfigDigest +
  inputArtifactDigests
)
```

A completed step result is immutable and reusable; a failed attempt is separately recorded; a retry re-executes only the unresolved step. This is materially different from replaying an entire `parallel()` closure after one child fails. Inngest gives each `step.run()` an independent retry counter and persists successful step outputs for reuse; DBOS resumes from the last completed step; LangGraph preserves completed writes from other nodes at a failed super-step. [Inngest official error-handling documentation](https://www.inngest.com/docs/guides/error-handling) ([inngest.com](https://www.inngest.com/docs/guides/error-handling?utm_source=openai)) [DBOS official workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) ([docs.dbos.dev](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial?utm_source=openai)) [LangGraph official persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/persistence?utm_source=openai))

**(High Confidence)** The current prompt-chain SHA-256 journal key is useful for cache reuse but is not a sufficient execution identity. It does not encode retry count, plan revision, model configuration, side-effect idempotency status, next eligible retry time, pause reason, or queue mutation version. <INFERENCE from="https://www.inngest.com/docs/learn/how-functions-are-executed, https://docs.dbos.dev/architecture, https://docs.langchain.com/oss/python/langgraph/persistence">Comparable engines persist both completed results and execution metadata needed to replay safely; a cache key alone cannot express that lifecycle.</INFERENCE>

### 1.2 Comparative retry, persistence, pause, and mutation patterns

| System | Retry shape and cap | Jitter / classification | Persistence across restart | Pause / resume / mutation relevance |
|---|---|---|---|---|
| Temporal | Default activity policy: initial interval `1s`, coefficient `2`, maximum interval `100 × initial`, maximum attempts `0` meaning unlimited; `1` disables retries. [Temporal protocol/API documentation](https://api-docs.temporal.io/) ([api-docs.temporal.io](https://api-docs.temporal.io/?utm_source=openai)) | Supports explicit non-retryable error types; the reviewed API source does not document a user-facing jitter field. | Workflow history persists state transitions and scheduled work transactionally. [Temporal History Service architecture documentation](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md) ([github.com](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md?utm_source=openai)) | Signals mutate state asynchronously; Updates mutate state and return a result; Queries are read-only. Suitable for durable queue mutation. [Temporal Signals and Queries documentation](https://go.temporal.io/platform-hub/prompt-library/building/signals-queries) ([go.temporal.io](https://go.temporal.io/platform-hub/prompt-library/building/signals-queries?utm_source=openai)) |
| Restate | Default documented retry policy: `50ms` initial interval, `2.0` exponentiation factor, `70` max attempts, `60s` cap, `on-max-attempts = "pause"`. [Restate official configuration documentation](https://docs.restate.dev/services/configuration) ([docs.restate.dev](https://docs.restate.dev/services/configuration?utm_source=openai)) | Retry policy exposes interval, factor, cap, attempts, and pause-or-kill behavior. | Journaled durable invocations; restart-from-prefix preserves a retained journal prefix. [Restate invocation-management documentation](https://docs.restate.dev/services/invocation/managing-invocations) ([docs.restate.dev](https://docs.restate.dev/services/invocation/managing-invocations?utm_source=openai)) | Strongest direct precedent for retry exhaustion becoming a resumable paused state, with UI/CLI pause, resume, restart, and restart-from-prefix. |
| DBOS | Step settings include `retriesAllowed`, `intervalSeconds`, `maxAttempts`, `backoffRate`, and `shouldRetry(error)`. [DBOS TypeScript workflow/step reference](https://docs.dbos.dev/typescript/reference/workflows-steps) ([docs.dbos.dev](https://docs.dbos.dev/typescript/reference/workflows-steps?utm_source=openai)) | Explicit predicate permits transient-vs-terminal classification; no documented jitter parameter in reviewed source. | Completed steps are not re-executed; interrupted workflows resume from the last completed step. [DBOS workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) ([docs.dbos.dev](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial?utm_source=openai)) | Dashboard can pause a workflow, start stopped/enqueued work, and restart from a specific step. [DBOS architecture documentation](https://docs.dbos.dev/architecture) ([docs.dbos.dev](https://docs.dbos.dev/architecture?utm_source=openai)) |
| Inngest | Default is `4` retries after the initial attempt, therefore `5` total attempts; retries may be configured per function. [Inngest retry documentation](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries) ([inngest.com](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries?utm_source=openai)) | Exponential backoff “with some jitter”; `NonRetriableError` bypasses retries; `RetryAfterError` schedules a specific retry time. | Per-step state and error attempts are persisted; successful steps are reused rather than rerun. [Inngest durable-execution documentation](https://www.inngest.com/docs/learn/how-functions-are-executed) ([inngest.com](https://www.inngest.com/docs/learn/how-functions-are-executed?utm_source=openai)) | Event waits, cancellation events, fan-out, and direct invocation provide queue-like mutation primitives. [Inngest wait-for-event documentation](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event) ([inngest.com](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event?utm_source=openai)) |
| Prefect | Task `retries`, `retry_delay_seconds`, exponential backoff helper, jitter factor, and `retry_condition_fn`. [Prefect official retry documentation](https://docs.prefect.io/v3/how-to-guides/workflows/retries) ([docs.prefect.io](https://docs.prefect.io/v3/how-to-guides/workflows/retries?utm_source=openai)) | User-supplied predicate can reject terminal HTTP status codes or permit selected transient errors. | <MISSING_DATA>[Durable persistence and restart semantics were sought in official source material reviewed here; the retrieved retry page does not establish the exact persistence model.]</MISSING_DATA> | Useful API shape, but not the primary local-runtime durability reference. |
| Airflow | Fixed retry count/delay plus optional exponential backoff and maximum retry delay; current docs also describe exception retry policies. [Apache Airflow task documentation](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html) ([airflow.apache.org](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html?utm_source=openai)) | Airflow’s historical implementation computes deterministic per-task-instance jitter under exponential backoff. [Apache Airflow TaskInstance source documentation](https://airflow.apache.org/docs/apache-airflow/2.7.2/_modules/airflow/models/taskinstance.html) ([airflow.apache.org](https://airflow.apache.org/docs/apache-airflow/2.7.2/_modules/airflow/models/taskinstance.html?utm_source=openai)) | Task-instance state is scheduler/database-backed. | Strong warning: Airflow’s task/DAG semantics are heavier than required for an embedded CLI. |
| LangGraph | Default reviewed `RetryPolicy`: `3` total attempts, `0.5s` initial interval, `2.0` factor, `128s` max interval, jitter enabled. [LangGraph fault-tolerance documentation](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/fault-tolerance?utm_source=openai)) | Default retry classifier excludes many programming errors and retries HTTP 5xx for common HTTP libraries; policy accepts exception classes or predicates. | Checkpointers retain graph state, completed writes, and failure provenance. [LangGraph persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/persistence?utm_source=openai)) | `interrupt()`, `Command(resume=...)`, and `update_state()` are strong analogues for pause/resume and controlled live mutation. [LangGraph interrupt documentation](https://docs.langchain.com/oss/python/langgraph/interrupts) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/interrupts?utm_source=openai)) |
| Mastra | Snapshots retain remaining retries for each step. [Mastra snapshot reference](https://mastra.ai/en/reference/workflows/snapshots) ([mastra.ai](https://mastra.ai/en/reference/workflows/snapshots?utm_source=openai)) | Retry API details are not fully corroborated in the reviewed primary reference set. | Suspended workflow snapshots persist execution path, completed outputs, suspended metadata, and retry remainder. | `suspend()` / `resume()` and persisted snapshots are direct product analogues. [Mastra snapshot reference](https://mastra.ai/en/reference/workflows/snapshots) ([mastra.ai](https://mastra.ai/en/reference/workflows/snapshots?utm_source=openai)) |
| AutoGen | Agent setting `max_retry_limit` defaults to `2` in reviewed official documentation. [CrewAI agent documentation](https://github.com/crewAIInc/crewAI/blob/main/docs/en/concepts/agents.mdx) ([github.com](https://github.com/crewaiinc/crewai/blob/main/docs/en/concepts/agents.mdx?utm_source=openai)) | <INSUFFICIENT_EVIDENCE>[No comparable AutoGen transport-backoff policy was corroborated in the reviewed official material.]</INSUFFICIENT_EVIDENCE> | Agents, teams, and runtime state can be saved and loaded. [Microsoft AutoGen state-management documentation](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html) ([microsoft.github.io](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html?utm_source=openai)) | Teams expose `pause()` and `resume()`, but agent classes are responsible for implementing safe pause/resume behavior. [Microsoft AutoGen team API reference](https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.teams.html) ([microsoft.github.io](https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.teams.html?utm_source=openai)) |
| CrewAI | `max_retry_limit` defaults to `2` for agents in reviewed official docs. [CrewAI official repository documentation](https://github.com/crewAIInc/crewAI/blob/main/docs/en/concepts/agents.mdx) ([github.com](https://github.com/crewaiinc/crewai/blob/main/docs/en/concepts/agents.mdx?utm_source=openai)) | <INSUFFICIENT_EVIDENCE>[No durable retry-journal / restart-from-checkpoint semantics were corroborated in the retrieved official CrewAI material.]</INSUFFICIENT_EVIDENCE> | Flows offer structured state, but the retrieved source does not prove durable process-crash recovery. | Treat as an agent framework, not a durable execution reference. |
| OpenAI Agents SDK | The reviewed SDK documents loop cap `max_turns`, not a generic configurable transport retry scheduler. [OpenAI Agents SDK runner documentation](https://openai.github.io/openai-agents-python/running_agents/) ([openai.github.io](https://openai.github.io/openai-agents-python/running_agents/?utm_source=openai)) | Guardrail retries and failures can reuse saved `RunState` in specific cases. [OpenAI Agents SDK JavaScript running-agents guide](https://openai.github.io/openai-agents-js/guides/running-agents/) ([openai.github.io](https://openai.github.io/openai-agents-js/guides/running-agents/?utm_source=openai)) | `RunState` serializes context, usage, interruptions, responses, approvals, and server conversation identifiers. [OpenAI Agents SDK RunState reference](https://openai.github.io/openai-agents-python/ref/run_state/) ([openai.github.io](https://openai.github.io/openai-agents-python/ref/run_state/?utm_source=openai)) | Strong human-approval pause/resume model; weaker than durable engines for scheduler-owned retries. |
| claude-flow | <INSUFFICIENT_EVIDENCE>[Claims of automatic exponential-backoff retries and task queues appear in package/community materials, but authoritative implementation documentation sufficient for a design baseline was not corroborated.]</INSUFFICIENT_EVIDENCE> | — | — | Do not use as a control-plane reference until its implementation and persistence semantics are independently verified. |

**Correction:** The “AutoGen” row above intentionally references Microsoft AutoGen sources; the `max_retry_limit` statement belongs to **CrewAI**, not AutoGen. AutoGen’s verified contribution in this comparison is state save/load and team pause/resume. [Microsoft AutoGen state-management documentation](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html) ([microsoft.github.io](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html?utm_source=openai))

### 1.3 Recommended retry contract

**(High Confidence)** Implement the following policy as the default for LLM/API execution steps:

```ts
type RetryPolicy = {
  maxRetries: 30;                 // 30 retries after initial attempt = 31 attempts
  initialDelayMs: 2_000;
  multiplier: 2.0;
  maxDelayMs: 300_000;            // 5 minutes
  jitter: "full";                 // U[0, computedDelay]
  retryAfter: "honor-minimum";    // do not retry before provider’s Retry-After
  deadlineMs?: number;            // workflow- or step-level wall-clock budget
  classify(error: unknown): RetryDecision;
};

type RetryDecision =
  | { action: "retry"; reason: string; retryAfterMs?: number }
  | { action: "pause"; reason: "usage_limit" | "offline" | "manual_intervention"; resumeAt?: string }
  | { action: "fail"; reason: string }
  | { action: "cancel"; reason: string };
```

<INFERENCE from="https://api-docs.temporal.io/, https://docs.restate.dev/services/configuration, https://docs.dbos.dev/typescript/reference/workflows-steps, https://www.inngest.com/docs/features/inngest-functions/error-retries/retries, https://docs.langchain.com/oss/python/langgraph/fault-tolerance">The fields combine the independently documented retry controls—attempt cap, initial interval, multiplier, cap, explicit retry classification, Retry-After scheduling, and durable pause—into one local CLI policy.</INFERENCE>

**(High Confidence)** Persist `attemptNo`, `nextAttemptAt`, `delayMs`, `jitterSample`, provider request ID, normalized error class, HTTP status, retry classification, and an idempotency key *before* sleeping or returning control to the scheduler. Never regenerate jitter on a restart: the persisted `nextAttemptAt` is authoritative. <INFERENCE from="https://www.inngest.com/docs/learn/how-functions-are-executed, https://docs.langchain.com/oss/python/langgraph/fault-tolerance, https://docs.restate.dev/services/invocation/managing-invocations">Durable systems preserve attempt state and resume from persisted execution state; persisting the schedule avoids restart-dependent retry storms.</INFERENCE>

#### Error-classification matrix

| Error / signal | Default action | Rationale |
|---|---|---|
| HTTP `429` with `Retry-After` | `retry` at or after header time, plus small positive jitter | Inngest explicitly supports scheduling retries from an upstream `Retry-After` value. [Inngest retry documentation](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries) ([inngest.com](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries?utm_source=openai)) |
| HTTP `429` without usage-reset signal | `retry` under normal capped policy | Likely temporary concurrency or rate-limit pressure; record provider metadata. |
| Provider usage / spend / account-limit exhaustion with reset timestamp | `pause` as `PAUSED_USAGE_LIMIT`, `resumeAt = reset` | Avoids pointless retries while credentials are known to remain ineligible. <INFERENCE from="https://docs.restate.dev/services/configuration, https://docs.restate.dev/services/invocation/managing-invocations">Restate’s retry-exhaustion-to-pause behavior supports a user-resumable rather than terminal treatment.</INFERENCE> |
| HTTP `500`, `502`, `503`, `504`; `ECONNRESET`; `ETIMEDOUT`; temporary `ECONNREFUSED` | `retry` | These are conventional transient-service or transport failures; bounded retries prevent indefinite blockage. |
| DNS `ENOTFOUND` | Retry only if previous successful endpoint resolution exists or a network monitor reports outage; otherwise `pause` for diagnosis | A permanent misspelt hostname should not consume 31 attempts. |
| HTTP `400`, `401`, `403`, `404`, `413`, `422`; malformed request; unsupported model; invalid API key | `fail` | These are normally deterministic request/configuration faults. |
| User cancellation / abort | `cancel` | Must never be converted into retry or success. |
| Context-length or deterministic schema-validation failure | `fail` or route to an explicit fallback / compaction step | Retrying the same deterministic prompt unchanged is not recovery. |
| Unknown error | Retry for first `3` attempts only, then `pause` as `PAUSED_UNCLASSIFIED` | <INFERENCE from="https://docs.langchain.com/oss/python/langgraph/fault-tolerance, https://docs.dbos.dev/typescript/reference/workflows-steps">Comparable systems support explicit classification predicates; conservative escalation prevents silently retrying programmer errors 31 times.</INFERENCE> |

**(Medium Confidence)** For model calls whose provider does not offer request idempotency, label a post-crash result as `OUTCOME_UNKNOWN`, not simply retry-safe. Repeating an LLM call can be acceptable for generation, but repeating a tool invocation may duplicate a side effect. Require side-effecting tools to accept a stable idempotency key derived from `runId + nodeId + logicalOperationId`. <INFERENCE from="https://docs.dbos.dev/architecture, https://www.inngest.com/docs/guides/error-handling">DBOS and Inngest both explicitly require idempotent work because retry can repeat an external operation after ambiguous failure.</INFERENCE>

### 1.4 State model and journal replacement

**(High Confidence)** Retain append-only history for auditability, but make a local SQLite database the authoritative scheduler state. The existing `journal.jsonl` should become an exported event stream or migration input, not the only mutable state source.

```sql
runs(
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  plan_revision INTEGER,
  template_digest TEXT,
  control_state TEXT,
  health_state TEXT,
  created_at TEXT,
  updated_at TEXT,
  finished_at TEXT
);

nodes(
  run_id TEXT,
  node_id TEXT,
  logical_key TEXT,
  required BOOLEAN,
  state TEXT,
  input_digest TEXT,
  output_artifact_digest TEXT,
  pause_reason TEXT,
  next_attempt_at TEXT,
  PRIMARY KEY(run_id, node_id)
);

attempts(
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT,
  node_id TEXT,
  attempt_no INTEGER,
  started_at TEXT,
  completed_at TEXT,
  error_class TEXT,
  http_status INTEGER,
  provider_request_id TEXT,
  retry_decision TEXT,
  delay_ms INTEGER,
  next_attempt_at TEXT,
  idempotency_key TEXT
);

commands(
  command_id TEXT PRIMARY KEY,
  run_id TEXT,
  expected_plan_revision INTEGER,
  type TEXT,
  payload_json TEXT,
  status TEXT,
  created_at TEXT,
  applied_at TEXT
);

mailbox(
  message_id TEXT PRIMARY KEY,
  run_id TEXT,
  target_node_id TEXT,
  delivery_boundary TEXT,
  payload_json TEXT,
  consumed_at TEXT
);
```

<INFERENCE from="https://docs.langchain.com/oss/python/langgraph/persistence, https://docs.restate.dev/services/invocation/managing-invocations, https://docs.dbos.dev/architecture">The schema is a compact local implementation of checkpointed state, retry provenance, resumable commands, and restart-from-boundary semantics shown in comparable durable systems.</INFERENCE>

#### Required state axes

| Axis | States | UI meaning |
|---|---|---|
| `control_state` | `RUNNING`, `PAUSE_REQUESTED`, `PAUSED`, `CANCELLING`, `SUCCEEDED`, `FAILED`, `CANCELLED` | Operator intent and lifecycle. |
| `health_state` | `HEALTHY`, `RETRYING`, `DEGRADED`, `OFFLINE`, `USAGE_LIMITED`, `FAILED` | Operational health; may change while control remains `RUNNING`. |
| node state | `QUEUED`, `RUNNING`, `BACKING_OFF`, `PAUSE_REQUESTED`, `PAUSED`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `SKIPPED` | Actual unit-of-work disposition. |
| outcome | `SUCCEEDED`, `SUCCEEDED_WITH_WARNINGS`, `FAILED`, `CANCELLED` | Final, externally reported workflow result. |

**(High Confidence)** A workflow must not report `completed` unless every required node is `SUCCEEDED` or an explicitly permitted `SKIPPED`. A `null` produced after an API error must instead create a failed attempt record and leave the node `BACKING_OFF`, `PAUSED`, or `FAILED`. <INFERENCE from="https://www.inngest.com/docs/guides/error-handling, https://docs.dbos.dev/typescript/tutorials/workflow-tutorial">Comparable systems mark exhausted work as failed and preserve step failure context; they do not equate an exception with successful output.</INFERENCE>

### 1.5 Pause, resume, offline detection, and UI semantics

**(High Confidence)** Implement two distinct pause scopes:

1. **Node pause:** stop scheduling further attempts for one agent; retain all sibling execution.
2. **Workflow pause:** stop dequeuing new nodes; either drain in-flight nodes or cooperatively abort them at declared safe boundaries.

The default should be **drain**, because an in-flight model/tool call may already have succeeded remotely even when its local response has not yet been journaled. <INFERENCE from="https://docs.langchain.com/oss/python/langgraph/interrupts, https://docs.restate.dev/services/invocation/managing-invocations, https://docs.dbos.dev/java/reference/methods">Durable systems use persisted pause/cancel boundaries and caution that side effects can be replayed; draining avoids creating unnecessary ambiguous outcomes.</INFERENCE>

**(High Confidence)** The UI should use an amber warning/degraded state when one child is retrying or paused while independent siblings remain runnable. Reserve red failure for a terminal required-node failure or an exhausted retry policy with no defined fallback. Inngest distinguishes an exception from a failed step/function after retries exhaust; Restate distinguishes paused invocations from killed invocations; DBOS exposes `ERROR`, `CANCELLED`, and recovery-exhausted states separately. [Inngest official error-handling documentation](https://www.inngest.com/docs/guides/error-handling) ([inngest.com](https://www.inngest.com/docs/guides/error-handling?utm_source=openai)) [Restate invocation-management documentation](https://docs.restate.dev/services/invocation/managing-invocations) ([docs.restate.dev](https://docs.restate.dev/services/invocation/managing-invocations?utm_source=openai)) [DBOS workflow-state API reference](https://docs.dbos.dev/java/reference/methods) ([docs.dbos.dev](https://docs.dbos.dev/java/reference/methods?utm_source=openai))

#### Required workflow UI controls

| Control | Semantics |
|---|---|
| **Retry now** | Cancels only the persisted sleep and schedules the same unresolved node immediately. |
| **Resume node** | Clears a node pause after preserving reason and operator identity in `commands`. |
| **Resume workflow** | Reopens scheduler admission; does not rerun completed nodes. |
| **Pause workflow** | Writes `PAUSE_REQUESTED`; no new node begins; running work follows configured drain/abort mode. |
| **Retry from checkpoint** | Creates a new run revision from a selected durable checkpoint; prior run remains immutable. |
| **Skip optional node** | Requires explicit policy and audit command; yields `SUCCEEDED_WITH_WARNINGS`. |
| **Fail now** | Marks selected node terminally failed; causes parent resolution according to required/optional policy. |

**(Medium Confidence)** Connectivity-aware pausing should be based on evidence from both transport failures and a reachability probe, not merely macOS interface status. Recommend `SUSPECTED_OFFLINE` after two classified transport failures within 30 seconds across distinct agents or endpoints; pause new work after confirmation; auto-resume only after one authenticated provider preflight or successful retried request. <INFERENCE from="https://github.com/Shopify/toxiproxy, https://docs.restate.dev/ai/patterns/human-in-the-loop">Network fault injection demonstrates that link status and endpoint availability are distinct; durable pause/resume patterns support releasing work while awaiting external recovery.</INFERENCE>

**(Low Confidence)** Do not automatically resume after a usage-limit pause unless the provider supplies a reset time or an authenticated preflight confirms eligibility. <CONFIDENCE:LOW>[Provider-specific quota-reset signals and low-cost eligibility endpoints were not verified for Claude Code’s backing service in this investigation.]</CONFIDENCE:LOW>

### 1.6 Live queue mutation and message passing

**(High Confidence)** Treat every UI edit as a durable, idempotent command rather than directly mutating in-memory arrays:

```ts
type WorkflowCommand =
  | { id: string; type: "ADD_NODE"; expectedPlanRevision: number; node: NodeSpec }
  | { id: string; type: "REMOVE_NODE"; expectedPlanRevision: number; nodeId: string }
  | { id: string; type: "REORDER_QUEUE"; expectedPlanRevision: number; order: string[] }
  | { id: string; type: "SEND_AGENT_MESSAGE"; nodeId: string; message: AgentMessage }
  | { id: string; type: "PAUSE"; scope: "node" | "workflow" }
  | { id: string; type: "RESUME"; scope: "node" | "workflow" };
```

The scheduler applies each command transactionally only once, increments `plan_revision`, and records a conflict if `expectedPlanRevision` is stale. <INFERENCE from="https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md, https://docs.langchain.com/oss/python/langgraph/persistence">Temporal persists workflow state transitions transactionally, while LangGraph’s state updates create new checkpoints rather than mutating historical checkpoints; optimistic revisioning is the local analogue.</INFERENCE>

**(High Confidence)** Do not “inject” a message into an LLM call currently in flight. Deliver messages through a persisted mailbox at a declared agent boundary: before the next model call, after the current tool call, or upon an explicit cooperative interrupt. LangGraph’s interrupts and Restate’s durable promises both use boundary-based resume semantics rather than asynchronous mutation of arbitrary stack frames. [LangGraph interrupt documentation](https://docs.langchain.com/oss/python/langgraph/interrupts) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/interrupts?utm_source=openai)) [Restate external-events documentation](https://docs.restate.dev/develop/ts/external-events) ([docs.restate.dev](https://docs.restate.dev/develop/ts/external-events?utm_source=openai))

**(High Confidence)** Removal semantics must distinguish queued and running work:

- `QUEUED`: remove immediately and mark `CANCELLED`.
- `BACKING_OFF` / `PAUSED`: cancel pending retry or resume timer and mark `CANCELLED`.
- `RUNNING`: write `PAUSE_REQUESTED` or `CANCELLING`; invoke `AbortController` only where the operation is known to be safe; otherwise allow completion, then discard the result only if policy says the node was superseded.

DBOS documents cancellation as preemption at the next step boundary; this is the appropriate local model. [DBOS workflow-state API reference](https://docs.dbos.dev/java/reference/methods) ([docs.dbos.dev](https://docs.dbos.dev/java/reference/methods?utm_source=openai))

### 1.7 Workflow templating

**(High Confidence)** Extract reusable templates into declarative, versioned workflow plans—not copied JavaScript closures. Freeze a template expansion into the run at creation time:

```json
{
  "template": "research-review@3",
  "templateDigest": "sha256:...",
  "inputs": {
    "topic": "…",
    "providers": ["claude"]
  },
  "nodes": [
    {
      "id": "research",
      "kind": "agent",
      "required": true,
      "retryPolicyRef": "llm-transient-v1"
    },
    {
      "id": "review",
      "kind": "agent",
      "dependsOn": ["research"],
      "required": true
    }
  ]
}
```

<INFERENCE from="https://www.inngest.com/docs/reference/typescript/v4/functions/step-invoke, https://mastra.ai/ai-workflows">Durable systems compose reusable functions/workflows and persist graph state; freezing a template digest prevents a resumed run from silently changing behavior after template edits.</INFERENCE>

**(High Confidence)** Keep mutable operator changes in a run-local overlay (`plan_revision`) rather than modifying the source template. A resumed run must use the original template digest plus its command history unless the user explicitly creates a migration or a new run. This prevents cached prompt-chain prefixes from being replayed under an incompatible graph. <INFERENCE from="https://docs.langchain.com/oss/python/langgraph/persistence, https://docs.restate.dev/services/invocation/managing-invocations">Checkpoint/replay systems preserve historical execution state and provide explicit restart/fork semantics rather than silently editing prior history.</INFERENCE>

### 1.8 Patching a frequently updated minified single-file JavaScript bundle

#### Chosen mechanism

**(High Confidence)** Choose a **macOS launcher + version-gated AST transformation installer + local sidecar scheduler**.

1. `claude-resilient install` discovers the installed CLI target.
2. It records vendor version, target path, original SHA-256, bundle size, parse mode, and semantic-anchor counts.
3. It parses the target JavaScript with Babel/recast/jscodeshift-compatible tooling.
4. It inserts a small, namespaced resilience runtime and rewrites only verified call sites.
5. It writes a patched copy atomically, retains the original immutable backup, and records patched SHA-256.
6. `claude-resilient doctor` verifies the installed target before every launch; unknown fingerprints disable the patch rather than applying a heuristic patch.
7. A launcher invokes the verified patched target and starts the sidecar scheduler/UI bridge.

<INFERENCE from="https://github.com/facebook/jscodeshift, https://nodejs.org/api/cli.html">AST codemods operate on syntax tree structure rather than text, while Node preload support is conditional on normal Node startup; a version-gated transform is therefore the reliable baseline for a changing minified bundle.</INFERENCE>

#### Mechanism comparison

| Mechanism | Decision | Why |
|---|---|---|
| AST-based source transform | **Primary** | Survives identifier renaming better than textual patching when anchored on call structure, literals, error branches, and surrounding behavior. jscodeshift is explicitly designed for AST-to-AST code modification. [jscodeshift official repository](https://github.com/facebook/jscodeshift) ([github.com](https://github.com/facebook/jscodeshift?utm_source=openai)) |
| `NODE_OPTIONS=--require` preload / module interception | **Conditional optimization** | Node supports preloaded modules via `NODE_OPTIONS`; use only after a probe proves the CLI honors it and loads target code through interceptable Node module paths. [Node.js CLI documentation](https://nodejs.org/api/cli.html) ([nodejs.org](https://nodejs.org/api/cli.html?utm_source=openai)) |
| `patch-package` | **Reject as primary mechanism** | It is designed for patching package contents on clean dependency installation; vendor CLI updates and bundled artifacts make its patch context brittle. [patch-package issue documenting clean-install patch constraints](https://github.com/ds300/patch-package/issues/557) ([github.com](https://github.com/ds300/patch-package/issues/557?utm_source=openai)) |
| ASAR extraction/repack | **Use only if packaging probe confirms Electron ASAR and no integrity/signing barrier** | ASAR archives are read-only at runtime and require extract/repack; this adds update and integrity risk. [Electron ASAR documentation](https://www.electronjs.org/docs/latest/tutorial/asar-archives) ([electronjs.org](https://www.electronjs.org/docs/latest/tutorial/asar-archives?utm_source=openai)) |
| Binary diff / byte patch | **Reject** | Highly sensitive to bundle layout, offsets, compiler output, and code-signing/integrity behavior. |
| Fuzzy textual patch | **Reject for automatic install** | A fuzzy match can patch the wrong minified branch and silently corrupt execution semantics. |
| Source-copy replacement without fingerprinting | **Reject** | Update detection and reproducibility become impossible. |

**(High Confidence)** Require all of the following compatibility gates before patching:

```ts
type BundleFingerprint = {
  vendorVersion: string;
  originalSha256: string;
  byteLength: number;
  parseMode: "cjs" | "esm";
  anchors: {
    parallelCallSites: 1 | 2 | number;
    pipelineCallSites: 1 | 2 | number;
    apiErrorTerminalBranches: number;
    journalWriterSites: number;
  };
  transformVersion: string;
};
```

The installer must require expected anchor cardinalities. A mismatch is `INCOMPATIBLE_VENDOR_BUILD`, not “best effort.” <INFERENCE from="https://github.com/facebook/jscodeshift, https://www.electronjs.org/docs/latest/tutorial/asar-archives">AST tooling can report structural matches, while bundled archives are immutable at runtime; fail-closed verification is safer than automatic fuzzy remediation.</INFERENCE>

**(Medium Confidence)** If the CLI is a normal Node CommonJS process, a preload may implement the transformation in-memory by intercepting target-module loading and compiling the transformed source. This avoids altering vendor files. If it is a Node single executable, embedded snapshot, ESM-only path, signed macOS app, or ASAR-integrity-protected package, that method may not work. [Node.js CLI documentation](https://nodejs.org/api/cli.html) ([nodejs.org](https://nodejs.org/api/cli.html?utm_source=openai)) [Node.js single-executable project documentation](https://github.com/nodejs/single-executable) ([github.com](https://github.com/nodejs/single-executable?utm_source=openai)) [Electron ASAR documentation](https://www.electronjs.org/docs/latest/tutorial/asar-archives) ([electronjs.org](https://www.electronjs.org/docs/latest/tutorial/asar-archives?utm_source=openai))

<MISSING_DATA>[The exact current macOS Claude Code packaging format, code-signing behavior, target JavaScript load path, and whether its launcher honors NODE_OPTIONS were not independently verified in this investigation. The installer must probe these facts before selecting preload versus materialized AST-patch delivery.]</MISSING_DATA>

### 1.9 Evaluation and chaos-testing plan

**(High Confidence)** Add deterministic unit tests with fake time, fake randomness, and a scripted provider transport. Verify:

1. Retry count never exceeds `31` total attempts.
2. `nextAttemptAt` survives restart unchanged.
3. A completed sibling is never rerun because another sibling fails.
4. `Retry-After` is respected.
5. A usage-limit response creates `PAUSED_USAGE_LIMIT`, not `SUCCEEDED`.
6. A required failed node can never produce overall `SUCCEEDED`.
7. Duplicate UI commands with the same `command_id` are applied once.
8. A stale `expectedPlanRevision` produces conflict, not a lost update.
9. A crash between “attempt started” and “response recorded” yields `OUTCOME_UNKNOWN`.
10. Offline pause/resume cannot cause a retry herd on reconnection.

<INFERENCE from="https://docs.langchain.com/oss/python/langgraph/fault-tolerance, https://docs.dbos.dev/architecture, https://www.inngest.com/docs/learn/how-functions-are-executed">These invariants directly test the checkpointed retries, failure provenance, and successful-step reuse documented by durable execution systems.</INFERENCE>

**(High Confidence)** Add integration fault injection through Toxiproxy for connection reset, timeout, latency, bandwidth throttling, packet loss, and hard outage. Toxiproxy explicitly supports `reset_peer`, `timeout`, `latency`, `bandwidth`, `packet_loss`, and proxy disablement. [Shopify Toxiproxy official repository](https://github.com/Shopify/toxiproxy) ([github.com](https://github.com/shopify/toxiproxy?utm_source=openai))

**(High Confidence)** Add a process-kill crash matrix. Terminate the CLI or sidecar immediately after every durable boundary:

```text
command persisted
node dequeued
attempt started
request dispatch recorded
response received but before commit
result artifact persisted
node success committed
retry timer persisted
pause command persisted
template mutation committed
```

On restart, assert that the materialized state matches the event history and that no operation is falsely marked successful. <INFERENCE from="https://docs.restate.dev/services/invocation/managing-invocations, https://docs.langchain.com/oss/python/langgraph/persistence">Restart-from-prefix and checkpoint recovery models demonstrate that correctness depends on behavior at interruption boundaries, not only exception handling.</INFERENCE>

---

### 2. What is the current state, strongest supporting evidence, contrasting views, recent change, and trajectory?

**(High Confidence)** The 2024-2026 trajectory is toward durable, step-granular agent execution: checkpoint the outputs of model/tool steps, persist retry state outside the worker process, pause for external input or retry exhaustion, and expose resume/state mutation through explicit control-plane operations. Evidence spans Inngest’s durable-agent documentation, LangGraph’s persisted checkpoints and interrupts, Restate’s pause-on-exhaustion policy, DBOS recovery from durable steps, and OpenAI Agents SDK `RunState`. [Inngest durable-agents documentation](https://www.inngest.com/docs/learn/durable-agents) ([inngest.com](https://www.inngest.com/docs/learn/durable-agents?utm_source=openai)) [LangGraph persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/persistence?utm_source=openai)) [Restate configuration documentation](https://docs.restate.dev/services/configuration) ([docs.restate.dev](https://docs.restate.dev/services/configuration?utm_source=openai)) [DBOS architecture documentation](https://docs.dbos.dev/architecture) ([docs.dbos.dev](https://docs.dbos.dev/architecture?utm_source=openai)) [OpenAI Agents SDK RunState reference](https://openai.github.io/openai-agents-python/ref/run_state/) ([openai.github.io](https://openai.github.io/openai-agents-python/ref/run_state/?utm_source=openai))

**(High Confidence)** There is no universal retry cap. Temporal’s reviewed default policy permits unlimited attempts under applicable timeouts, Restate documents a default `70` attempt policy ending in pause, Inngest defaults to four retries after the initial execution, and LangGraph defaults to three total attempts. The correct conclusion is not that “30” is industry standard; it is that a cap must be paired with a deadline, error classifier, and a resumable exhausted state. [Temporal protocol/API documentation](https://api-docs.temporal.io/) ([api-docs.temporal.io](https://api-docs.temporal.io/?utm_source=openai)) [Restate configuration documentation](https://docs.restate.dev/services/configuration) ([docs.restate.dev](https://docs.restate.dev/services/configuration?utm_source=openai)) [Inngest retry documentation](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries) ([inngest.com](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries?utm_source=openai)) [LangGraph fault-tolerance documentation](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/fault-tolerance?utm_source=openai))

<CONFLICTING_EVIDENCE>[Temporal’s defaults favor long-lived retry under timeouts, whereas Restate’s documented default ends in a paused invocation after a finite attempt budget. Inngest uses a low default retry count but supports explicit non-retriable and Retry-After errors. The disagreement is product-policy trade-off, not factual contradiction: automatic recovery maximizes eventual completion; bounded retries plus pause limits cost and avoids repeated execution of deterministic bugs.]</CONFLICTING_EVIDENCE>

**(High Confidence)** Durable engines converge on “retry failed leaf work, preserve completed work,” but general agent SDKs often expose only partial durability. OpenAI’s Agents SDK can serialize and resume interrupted state for approvals; AutoGen can save/load agent and team state; neither reviewed source establishes a scheduler-managed general transport retry policy comparable to Restate/Temporal/DBOS/Inngest. [OpenAI Agents SDK human-in-the-loop documentation](https://openai.github.io/openai-agents-python/human_in_the_loop/) ([openai.github.io](https://openai.github.io/openai-agents-python/human_in_the_loop/?utm_source=openai)) [Microsoft AutoGen state documentation](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html) ([microsoft.github.io](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html?utm_source=openai))

**(Medium Confidence)** Recent product direction reinforces this split: Mastra announced resumable durable agents and resumable streams on April 30, 2026, and documented a Temporal integration on May 27, 2026; LangGraph documents node-level error handlers and timeouts as Python-only features requiring `langgraph>=1.2`, currently alpha in the reviewed docs. [Mastra official release notes](https://github.com/mastra-ai/mastra/releases) ([github.com](https://github.com/mastra-ai/mastra/releases?utm_source=openai)) [Mastra official engineering blog, May 27 2026](https://mastra.ai/blog/mastra-workflows-enhanced) ([mastra.ai](https://mastra.ai/blog/mastra-workflows-enhanced?utm_source=openai)) [LangGraph fault-tolerance documentation](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/fault-tolerance?utm_source=openai))

#### Requested model-centric comparison fields

| Evaluated category | Parameter Count | Context Window | Latency | Cost | License | Relevance to this decision |
|---|---:|---:|---:|---:|---|---|
| Temporal / Restate / DBOS / Inngest / Prefect / Airflow | N/A | N/A | <MISSING_DATA>[No comparable end-to-end latency benchmark was found in the reviewed primary sources.]</MISSING_DATA> | <MISSING_DATA>[Pricing was excluded from scope.]</MISSING_DATA> | Varies | These are orchestration systems, not models. |
| LangGraph / Mastra / AutoGen / CrewAI / OpenAI Agents SDK | N/A | Provider-dependent | <MISSING_DATA>[No normalized benchmark was found in the reviewed primary sources.]</MISSING_DATA> | Provider-dependent | Varies | Framework behavior matters; model fields do not decide retry correctness. |
| Local Claude Code patch layer | N/A | Underlying CLI/model dependent | Dominated by provider call and backoff time | Local runtime cost plus model usage | Depends on vendor terms and patch distribution | The design must preserve recovery semantics, not optimize model architecture. |

**(High Confidence)** For a local, embedded CLI runtime, the build-vs-buy decision favors **build a narrow durability layer**, not adopt a remote workflow server: the required primitives are local persistence, a scheduler, a command log, retry classification, safe checkpoints, and an installer/compatibility gate. Buying Temporal/Restate/DBOS would provide stronger durability but introduces a separate service, persistence backend, deployment model, and operational surface disproportionate to a single-user macOS patch layer. <INFERENCE from="https://docs.dbos.dev/why-dbos, https://docs.restate.dev/services/configuration, https://docs.temporal.io/">DBOS, Restate, and Temporal document server-side durable execution architectures; the local CLI requirement makes a reduced embedded implementation the lower-operational-burden option.</INFERENCE>

## Evidence Table

| Claim | Primary Source | Publication Date | Evidence Type | URL |
|---|---|---|---|---|
| Temporal retry policy supports initial interval, coefficient, max interval, max attempts, and non-retryable error types. | Temporal Technologies | Living API documentation; retrieved August 7, 2026 | Official protocol/API documentation; primary implementation contract. | [https://api-docs.temporal.io/](https://api-docs.temporal.io/) ([api-docs.temporal.io](https://api-docs.temporal.io/?utm_source=openai)) |
| Restate defaults to `50ms`, factor `2.0`, `70` attempts, `60s` cap, then pause. | Restate | Living documentation; retrieved August 7, 2026 | Official configuration reference; primary runtime semantics. | [https://docs.restate.dev/services/configuration](https://docs.restate.dev/services/configuration) ([docs.restate.dev](https://docs.restate.dev/services/configuration?utm_source=openai)) |
| Restate UI/CLI can pause, resume, restart, and restart from retained journal prefix. | Restate | Living documentation; retrieved August 7, 2026 | Official operational documentation; primary control-plane reference. | [https://docs.restate.dev/services/invocation/managing-invocations](https://docs.restate.dev/services/invocation/managing-invocations) ([docs.restate.dev](https://docs.restate.dev/services/invocation/managing-invocations?utm_source=openai)) |
| DBOS exposes retry fields, `shouldRetry`, and step timeouts. | DBOS | Living documentation; retrieved August 7, 2026 | Official API reference; primary SDK contract. | [https://docs.dbos.dev/typescript/reference/workflows-steps](https://docs.dbos.dev/typescript/reference/workflows-steps) ([docs.dbos.dev](https://docs.dbos.dev/typescript/reference/workflows-steps?utm_source=openai)) |
| DBOS resumes interrupted workflows from the last completed step and does not rerun completed steps. | DBOS | Living documentation; retrieved August 7, 2026 | Official tutorial; primary behavior statement. | [https://docs.dbos.dev/typescript/tutorials/workflow-tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) ([docs.dbos.dev](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial?utm_source=openai)) |
| Inngest defaults to four retries after the first attempt, uses exponential backoff with jitter, supports non-retriable and Retry-After errors. | Inngest | Living documentation; retrieved August 7, 2026 | Official retry reference; primary SDK contract. | [https://www.inngest.com/docs/features/inngest-functions/error-retries/retries](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries) ([inngest.com](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries?utm_source=openai)) |
| Inngest persists step state and resumes failed work from the last successful step. | Inngest | Living documentation; retrieved August 7, 2026 | Official durable-execution documentation; primary implementation behavior. | [https://www.inngest.com/docs/learn/how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed) ([inngest.com](https://www.inngest.com/docs/learn/how-functions-are-executed?utm_source=openai)) |
| LangGraph RetryPolicy has documented default attempts, interval, factor, max interval, jitter, and classifier. | LangChain | Living documentation; retrieved August 7, 2026 | Official framework documentation; primary API behavior. | [https://docs.langchain.com/oss/python/langgraph/fault-tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/fault-tolerance?utm_source=openai)) |
| LangGraph checkpointers preserve state, pending writes, replay, and `update_state`. | LangChain | Living documentation; retrieved August 7, 2026 | Official persistence documentation; primary state model. | [https://docs.langchain.com/oss/python/langgraph/persistence](https://docs.langchain.com/oss/python/langgraph/persistence) ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/persistence?utm_source=openai)) |
| Mastra snapshots preserve suspended-step state and remaining retries. | Mastra | Living documentation; retrieved August 7, 2026 | Official workflow-state reference; primary product behavior. | [https://mastra.ai/en/reference/workflows/snapshots](https://mastra.ai/en/reference/workflows/snapshots) ([mastra.ai](https://mastra.ai/en/reference/workflows/snapshots?utm_source=openai)) |
| AutoGen supports saving/loading state and team pause/resume APIs. | Microsoft | Living documentation; retrieved August 7, 2026 | Official framework API documentation; primary SDK contract. | [https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html) ([microsoft.github.io](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html?utm_source=openai)) |
| OpenAI Agents SDK `RunState` is serializable and supports approval-driven resume. | OpenAI | Living documentation; retrieved August 7, 2026 | Official SDK reference; primary API contract. | [https://openai.github.io/openai-agents-python/ref/run_state/](https://openai.github.io/openai-agents-python/ref/run_state/) ([openai.github.io](https://openai.github.io/openai-agents-python/ref/run_state/?utm_source=openai)) |
| Node supports `NODE_OPTIONS` and preloaded `--require` modules. | Node.js project | Living documentation; retrieved August 7, 2026 | Official runtime documentation; primary runtime behavior. | [https://nodejs.org/api/cli.html](https://nodejs.org/api/cli.html) ([nodejs.org](https://nodejs.org/api/cli.html?utm_source=openai)) |
| jscodeshift is an AST codemod toolkit built around recast. | Meta / jscodeshift maintainers | Living repository documentation; retrieved August 7, 2026 | Official project repository; primary tool behavior. | [https://github.com/facebook/jscodeshift](https://github.com/facebook/jscodeshift) ([github.com](https://github.com/facebook/jscodeshift?utm_source=openai)) |
| Electron ASAR archives are read-only at runtime and require extract/repack for modification. | Electron | Living documentation; retrieved August 7, 2026 | Official Electron documentation; primary packaging behavior. | [https://www.electronjs.org/docs/latest/tutorial/asar-archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives) ([electronjs.org](https://www.electronjs.org/docs/latest/tutorial/asar-archives?utm_source=openai)) |
| Toxiproxy simulates resets, timeouts, latency, bandwidth constraints, and packet loss. | Shopify | Living repository documentation; retrieved August 7, 2026 | Official project repository; primary fault-injection behavior. | [https://github.com/Shopify/toxiproxy](https://github.com/Shopify/toxiproxy) ([github.com](https://github.com/shopify/toxiproxy?utm_source=openai)) |

## Knowledge Gaps

### Packaging and compatibility

<MISSING_DATA>[Exact Claude Code macOS distribution format, target bundle path, whether code signing or integrity verification is enforced, whether the CLI is an ordinary Node process, whether NODE_OPTIONS is honored, and whether the relevant workflow runtime is CommonJS or ESM. Needed: controlled inspection of the installed binary/app bundle and a harmless preload probe.]</MISSING_DATA>

### Provider-specific classification

<MISSING_DATA>[Authoritative error payloads, usage-limit reset fields, Retry-After behavior, request-idempotency support, and low-cost authenticated health-check endpoints for the Claude Code backing API. Needed: official provider API documentation plus captured redacted error fixtures.]</MISSING_DATA>

### Existing workflow internals

<MISSING_DATA>[The exact internal functions implementing `parallel()`, `pipeline()`, append-only journaling, cache-prefix replay, UI state, and terminal `null` propagation were supplied as runtime context but not independently inspected. Needed: source-map/bundle analysis and fixture workflows.]</MISSING_DATA>

### Legal and support posture

<MISSING_DATA>[Vendor terms, code-signing implications, update behavior, and supportability of modifying a local vendor-distributed CLI bundle. Needed: current Anthropic license/terms review by counsel or responsible internal policy owner.]</MISSING_DATA>

### Framework evidence gaps

<INSUFFICIENT_EVIDENCE>[For claude-flow, authoritative primary sources establishing exact retry policy, jitter, persisted attempt state, restart behavior, and UI control semantics were not corroborated. Package metadata and marketplace descriptions should not drive this architecture.]</INSUFFICIENT_EVIDENCE>

## Recommended Next Steps

1. **Run a packaging reconnaissance spike.**  
   **Rationale:** Select the actual delivery mechanism—Node preload versus materialized AST patch—only after proving the CLI’s executable format, target module path, signing/integrity behavior, and `NODE_OPTIONS` behavior.

2. **Build a minimal sidecar proof of concept before editing the bundle.**  
   **Rationale:** Implement SQLite-backed `runs`, `nodes`, `attempts`, and `commands`; validate 429/5xx/usage-limit handling against a fake provider. This isolates correctness from bundle-patching risk.

3. **Create a golden bundle corpus and AST transform harness.**  
   **Rationale:** Store several vendor versions, expected anchor counts, transformed output hashes, and behavioral fixtures. Require the installer to reject every unknown or ambiguously matched bundle.

4. **Define provider error fixtures and an explicit retry-classification contract.**  
   **Rationale:** The largest correctness risk is misclassifying usage exhaustion, auth failures, invalid prompts, and ambiguous post-dispatch failures as generic retryable errors.

5. **Establish a kill-and-restart chaos gate in CI.**  
   **Rationale:** A retry feature is not durable until process termination at every persistence boundary proves that attempts, queue edits, pause state, and completed sibling outputs recover without duplication or false completion.

## Sources

- [Error Handling & Retries in Inngest - Inngest Docs](https://www.inngest.com/docs/guides/error-handling?utm_source=openai)
- [Workflows | DBOS Docs](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial?utm_source=openai)
- [Persistence - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/persistence?utm_source=openai)
- [Automatic Retries in Inngest | Config & Behavior - Inngest Docs](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries?utm_source=openai)
- [Workflows & Steps | DBOS Docs](https://docs.dbos.dev/typescript/reference/workflows-steps?utm_source=openai)
- [Protocol Documentation](https://api-docs.temporal.io/?utm_source=openai)
- [Fault tolerance - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/fault-tolerance?utm_source=openai)
- [Service Configuration - Restate](https://docs.restate.dev/services/configuration?utm_source=openai)
- [Managing Invocations - Restate](https://docs.restate.dev/services/invocation/managing-invocations?utm_source=openai)
- [Command-line API | Node.js v26.5.1 Documentation](https://nodejs.org/api/cli.html?utm_source=openai)
- [GitHub - facebook/jscodeshift: A JavaScript codemod toolkit. · GitHub](https://github.com/facebook/jscodeshift?utm_source=openai)
- [GitHub - Shopify/toxiproxy: :alarm_clock: A TCP proxy to simulate network and system conditions f...](https://github.com/shopify/toxiproxy?utm_source=openai)
- [temporal/docs/architecture/history-service.md at main · temporalio/temporal · GitHub](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md?utm_source=openai)
- [Signals & Queries | Temporal Platform Hub](https://go.temporal.io/platform-hub/prompt-library/building/signals-queries?utm_source=openai)
- [DBOS Architecture | DBOS Docs](https://docs.dbos.dev/architecture?utm_source=openai)
- [How Inngest Functions Execute | Durable Execution - Inngest Docs](https://www.inngest.com/docs/learn/how-functions-are-executed?utm_source=openai)
- [step.waitForEvent() | Pause and Resume on an Event - Inngest Docs](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event?utm_source=openai)
- [How to automatically rerun your workflow when it fails - Prefect](https://docs.prefect.io/v3/how-to-guides/workflows/retries?utm_source=openai)
- [Tasks — Airflow 3.3.0 Documentation](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html?utm_source=openai)
- [airflow.models.taskinstance — Airflow Documentation](https://airflow.apache.org/docs/apache-airflow/2.7.2/_modules/airflow/models/taskinstance.html?utm_source=openai)
- [Interrupts - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/interrupts?utm_source=openai)
- [Reference: Snapshots | Workflow State Persistence | Mastra Docs](https://mastra.ai/en/reference/workflows/snapshots?utm_source=openai)
- [crewAI/docs/en/concepts/agents.mdx at main · crewAIInc/crewAI · GitHub](https://github.com/crewaiinc/crewai/blob/main/docs/en/concepts/agents.mdx?utm_source=openai)
- [Managing State — AutoGen](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html?utm_source=openai)
- [autogen_agentchat.teams — AutoGen](https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.teams.html?utm_source=openai)
- [Running agents - OpenAI Agents SDK](https://openai.github.io/openai-agents-python/running_agents/?utm_source=openai)
- [Running Agents | OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/running-agents/?utm_source=openai)
- [Run state - OpenAI Agents SDK](https://openai.github.io/openai-agents-python/ref/run_state/?utm_source=openai)
- [DBOS Methods & Variables | DBOS Docs](https://docs.dbos.dev/java/reference/methods?utm_source=openai)
- [External Events - Restate](https://docs.restate.dev/develop/ts/external-events?utm_source=openai)
- [Changing an existing patch is problematic in some situations · Issue #557 · ds300/patch-package](https://github.com/ds300/patch-package/issues/557?utm_source=openai)
- [ASAR Archives | Electron](https://www.electronjs.org/docs/latest/tutorial/asar-archives?utm_source=openai)
- [GitHub - nodejs/single-executable: This team aims to advance the state of the art in packaging No...](https://github.com/nodejs/single-executable?utm_source=openai)
- [Durable Agents - Inngest Docs](https://www.inngest.com/docs/learn/durable-agents?utm_source=openai)
- [Human-in-the-loop - OpenAI Agents SDK](https://openai.github.io/openai-agents-python/human_in_the_loop/?utm_source=openai)
- [Releases · mastra-ai/mastra · GitHub](https://github.com/mastra-ai/mastra/releases?utm_source=openai)
- [Mastra Workflows, Enhanced | Mastra Blog](https://mastra.ai/blog/mastra-workflows-enhanced?utm_source=openai)
