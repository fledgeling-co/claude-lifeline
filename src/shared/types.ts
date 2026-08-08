import type { ErrorClass } from "./classifier.js";

/** State of a single agent in the retry ledger. */
export type AgentState =
  | "running" // live and healthy — working, never in recovery
  | "retrying"
  | "stalled" // alive but produced no output / no context change for the stall window
  | "paused-offline"
  | "paused-usage-limit"
  | "paused-manual"
  | "failed-terminal"
  | "done";

/** Run-level rollup shown in `lifeline status`. */
export type RunState =
  | "running"
  | "completed"
  | "completed-with-failures" // at least one agent failed terminally but the run finished
  | "warning" // an agent is failing/recovering while siblings still run
  | "recovering";

/** One ledger entry, keyed by the workflow's sha256 prompt-chain key. */
export interface LedgerEntry {
  key: string; // sha256 prompt-chain key (the workflow cache key)
  runId: string;
  item: string | null; // human item id parsed from the transcript (e.g. DIO-0012)
  agentId: string | null;
  attempts: number;
  nextRetryAt: number | null; // epoch ms
  firstFailureAt: number | null; // epoch ms — anchors the duration budget
  lastClass: ErrorClass | null;
  lastError: string | null;
  state: AgentState;
  updatedAt: number;
}

/**
 * A whole-workflow resume that has been dispatched and is awaiting transcript evidence.
 *
 * Recovery resumes a workflow run, not an individual agent.  Keeping this lease on the run
 * prevents every stale lost-agent record (and overlapping daemon ticks) from launching the same
 * `claude --resume` workflow again.
 */
export interface RecoveryLease {
  key: string;
  startedAt: number;
  pid: number | null;
}

export interface RunLedger {
  runId: string;
  project: string;
  sessionId: string;
  scriptPath: string | null;
  args: unknown;
  entries: Record<string, LedgerEntry>; // keyed by LedgerEntry.key
  /** Null until a resume has been launched; cleared only by newer transcript evidence. */
  recoveryLease?: RecoveryLease | null;
  /** A run-scoped operator pause also applies to losses discovered after the pause. */
  manualPauseAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A control intent written by the CLI and honoured by the daemon. */
/** The control actions a person can take, from the CLI or the status window. */
export type ControlVerb = "retry" | "pause" | "resume";

export interface ControlIntent {
  id: string;
  kind: ControlVerb | "set-option";
  target: { runId: string; agentId?: string | null }; // agentId absent => whole run
  createdAt: number;
  /**
   * `set-option` only: a setting to persist to config.json. The status window has no store of
   * its own, and the DAEMON is what acts on these, so config.json stays the single source of
   * truth rather than the app holding a second copy that can disagree with it.
   */
  option?: { key: SettableOption; value: boolean | number } | null;
}

/** The settings the status window is allowed to change. Deliberately a closed list. */
export type SettableOption = "summaries.enabled" | "completedRetentionMs";

/** Connectivity events emitted by the gateway, consumed by the daemon. */
export interface ConnectivityEvent {
  online: boolean;
  at: number;
  reason: string;
}

/** The status snapshot the daemon writes and the CLI/UI read. */
export interface StatusSnapshot {
  updatedAt: number;
  online: boolean;
  runs: StatusRun[];
}

export interface StatusRun {
  runId: string;
  project: string;
  /** The workflow's own name (meta.name), e.g. "perch-fleet-run7". */
  workflowName?: string | null;
  /** The workspace (repo) name, e.g. "diolog-swe-bench". */
  workspace?: string | null;
  state: RunState;
  agents: StatusAgent[];
  /** Agents actively working right now (live or stalled), for the compact row summary. */
  runningCount?: number | null;
  /** Agents planned but not yet started (planned total minus started), or null if unknown. */
  pendingCount?: number | null;
  /** Agents that have finished, for a completed run's summary. */
  doneCount?: number | null;
  /** Elapsed wall-clock of the run so far, ms (earliest agent activity → now). */
  durationMs?: number | null;
  /** Highest context-window fill across the run's agents, 0..1, or null if unknown. */
  contextFrac?: number | null;
  /** One-line "what is this run doing now" narrator, if derivable. */
  note?: string | null;
  /** Repo the run's agents worked in (from the transcript cwd). */
  cwd?: string | null;
  /** Terminal program hosting the run's claude session, for the reveal action. */
  term?: string | null;
  /** Controlling tty of the run's claude session, for the reveal action. */
  tty?: string | null;
  /** Last cleaned lines of the top-level claude session that launched this run. */
  callerTail?: string[];
  /** A short generated name for the run, when summaries are on. Falls back to workflowName. */
  title?: string | null;
  /** One short line on where the run is overall, e.g. "waiting on 3 tasks". */
  stateLine?: string | null;
  /** The coarse state behind `stateLine`: working | waiting | blocked | almost-done | done. */
  summaryState?: string | null;
}

export interface StatusAgent {
  agentId: string | null;
  item: string | null;
  state: AgentState;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  lastClass: ErrorClass | null;
  /** Elapsed wall-clock of the agent, ms (first → last transcript timestamp). */
  durationMs?: number | null;
  /** Context-window fill 0..1 from the latest usage record, or null if unknown. */
  contextFrac?: number | null;
  /** Actual context tokens in the window (input + cache), the real number the TUI shows. */
  contextTokens?: number | null;
  /** How long the agent has been quiet, ms — set when state is "stalled". */
  stalledForMs?: number | null;
  /** Last few cleaned transcript lines (newest last), for the expandable log. */
  tail?: string[];
  /** What this agent is working on right now, in a phrase, when summaries are on. */
  activity?: string | null;
}
