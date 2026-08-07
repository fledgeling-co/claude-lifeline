import type { ErrorClass } from "./classifier.js";

/** State of a single agent in the retry ledger. */
export type AgentState =
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

export interface RunLedger {
  runId: string;
  project: string;
  sessionId: string;
  scriptPath: string | null;
  args: unknown;
  entries: Record<string, LedgerEntry>; // keyed by LedgerEntry.key
  createdAt: number;
  updatedAt: number;
}

/** A control intent written by the CLI and honoured by the daemon. */
export interface ControlIntent {
  id: string;
  kind: "retry" | "pause" | "resume";
  target: { runId: string; agentId?: string | null }; // agentId absent => whole run
  createdAt: number;
}

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
  state: RunState;
  agents: StatusAgent[];
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
  /** How long the agent has been quiet, ms — set when state is "stalled". */
  stalledForMs?: number | null;
  /** Last few cleaned transcript lines (newest last), for the expandable log. */
  tail?: string[];
}
