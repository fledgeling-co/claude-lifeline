/**
 * The retry ledger (Seam B persistence model, PLAN §3).
 *
 * A ledger is a SEPARATE mutable-state file keyed by the same sha256 prompt-chain key the
 * workflow runtime uses for its cache. It is deliberately NOT written into journal.jsonl:
 * the journal is a replay prefix and only non-null results belong there, so polluting it
 * with retry bookkeeping would corrupt cache-prefix replay.
 *
 * Everything in this file except load/save/list is pure, so the scheduling state machine
 * can be property-tested without touching a filesystem or a clock.
 */

import { readdirSync } from "node:fs";
import type { Classification, ErrorClass } from "../shared/classifier.js";
import type { BackoffPolicy } from "../shared/backoff.js";
import { nextDelay } from "../shared/backoff.js";
import { readJson, writeJsonAtomic } from "../shared/io.js";
import { paths } from "../shared/paths.js";
import type { AgentState, LedgerEntry, RunLedger } from "../shared/types.js";

/** States from which the daemon still intends to act on an entry. */
const ACTIVE_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "retrying",
  "paused-offline",
  "paused-usage-limit",
  "paused-manual",
]);

export function isActive(state: AgentState): boolean {
  return ACTIVE_STATES.has(state);
}

export function isTerminal(state: AgentState): boolean {
  return state === "failed-terminal" || state === "done";
}

/* ------------------------------------------------------------------ *
 * Pure constructors / reducers
 * ------------------------------------------------------------------ */

export interface NewLedgerInput {
  runId: string;
  project: string;
  sessionId: string;
  scriptPath: string | null;
  args: unknown;
  now: number;
}

export function emptyLedger(input: NewLedgerInput): RunLedger {
  return {
    runId: input.runId,
    project: input.project,
    sessionId: input.sessionId,
    scriptPath: input.scriptPath,
    args: input.args,
    entries: {},
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface NewEntryInput {
  key: string;
  runId: string;
  item: string | null;
  agentId: string | null;
  now: number;
}

/** A fresh entry: zero attempts, no failure recorded yet. */
export function newEntry(input: NewEntryInput): LedgerEntry {
  return {
    key: input.key,
    runId: input.runId,
    item: input.item,
    agentId: input.agentId,
    attempts: 0,
    nextRetryAt: null,
    firstFailureAt: null,
    lastClass: null,
    lastError: null,
    state: "retrying",
    updatedAt: input.now,
  };
}

/** Insert-or-replace by `entry.key`, returning a new ledger (never mutates the input). */
export function upsertEntry(ledger: RunLedger, entry: LedgerEntry): RunLedger {
  return {
    ...ledger,
    entries: { ...ledger.entries, [entry.key]: entry },
    updatedAt: Math.max(ledger.updatedAt, entry.updatedAt),
  };
}

export function getEntry(ledger: RunLedger, key: string): LedgerEntry | null {
  return ledger.entries[key] ?? null;
}

/**
 * The class → state mapping (feature spec §B). `exhausted` covers a schedule that ran out
 * of attempts or wall-clock budget, which is terminal regardless of how retryable the class
 * is: a binding that has been dead for an hour parks rather than churns.
 */
export function stateForClass(cls: ErrorClass, exhausted: boolean): AgentState {
  if (exhausted) return "failed-terminal";
  switch (cls) {
    case "RATE_LIMIT":
    case "OVERLOADED":
    case "CONN":
      return "retrying";
    case "USAGE_LIMIT":
      // A scheduled park, not a hot loop — the user's proxy rotates accounts with different
      // resets, so we retry on a schedule rather than hard-sleeping to one parsed reset.
      return "paused-usage-limit";
    case "CONTEXT":
    case "AUTH":
    case "UNKNOWN":
      return "failed-terminal";
  }
}

export interface ScheduleOptions {
  /** Injectable RNG in [0,1) for deterministic tests. */
  rng?: (() => number) | undefined;
  /** Raw error text to record on the entry. */
  lastError?: string | null | undefined;
}

/**
 * Record one observed failure against an entry and schedule the next attempt.
 *
 * `attempts` counts failures observed / retries scheduled, so the 0-based attempt index
 * handed to the backoff is the pre-increment `entry.attempts`. The duration budget is
 * anchored at `firstFailureAt` so a long-running recovery ends on time rather than after
 * a fixed number of hops.
 */
export function scheduleNext(
  entry: LedgerEntry,
  classification: Classification,
  policy: BackoffPolicy,
  now: number,
  options: ScheduleOptions = {},
): LedgerEntry {
  const firstFailureAt = entry.firstFailureAt ?? now;
  const base: LedgerEntry = {
    ...entry,
    attempts: entry.attempts + 1,
    firstFailureAt,
    lastClass: classification.class,
    lastError: options.lastError ?? entry.lastError,
    updatedAt: now,
  };

  if (!classification.retryable) {
    return { ...base, state: stateForClass(classification.class, false), nextRetryAt: null };
  }

  const delay = nextDelay({
    policy,
    attempt: entry.attempts,
    retryAfterMs: classification.retryAfterMs,
    elapsedMs: Math.max(0, now - firstFailureAt),
    ...(options.rng ? { rng: options.rng } : {}),
  });

  if (delay.delayMs === null) {
    return { ...base, state: "failed-terminal", nextRetryAt: null };
  }

  return {
    ...base,
    state: stateForClass(classification.class, false),
    nextRetryAt: now + delay.delayMs,
  };
}

/**
 * Re-arm the schedule after an attempt has been FIRED, without counting a new failure.
 *
 * `attempts` stays the failure counter (see `scheduleNext`), but a parked usage-limit agent
 * must keep probing on its jittered schedule — the user's proxy may free a different account
 * at any time — so firing a probe books the next one instead of clearing the schedule. The
 * duration budget is still consulted, so an entry that has outlived it parks terminally here
 * rather than probing forever.
 */
export function rearmAfterAttempt(
  entry: LedgerEntry,
  policy: BackoffPolicy,
  now: number,
  options: ScheduleOptions = {},
): LedgerEntry {
  if (entry.state !== "retrying" && entry.state !== "paused-usage-limit") {
    return { ...entry, nextRetryAt: null, updatedAt: now };
  }
  const delay = nextDelay({
    policy,
    attempt: entry.attempts,
    elapsedMs: Math.max(0, now - (entry.firstFailureAt ?? now)),
    ...(options.rng ? { rng: options.rng } : {}),
  });
  if (delay.delayMs === null) {
    return { ...entry, state: "failed-terminal", nextRetryAt: null, updatedAt: now };
  }
  return { ...entry, nextRetryAt: now + delay.delayMs, updatedAt: now };
}

/** Mark an entry done — the agent produced a real result, so recovery is over. */
export function markDone(entry: LedgerEntry, now: number): LedgerEntry {
  return { ...entry, state: "done", nextRetryAt: null, updatedAt: now };
}

/** Manual pause (a `pause` intent). Keeps attempts, drops the schedule. */
export function markPaused(entry: LedgerEntry, state: AgentState, now: number): LedgerEntry {
  return { ...entry, state, nextRetryAt: null, updatedAt: now };
}

/**
 * Re-arm an entry for a retry at `when`. Used by resume/retry intents and by the
 * connectivity-up path, which passes a per-entry jittered `when` so a reconnect does not
 * fire every parked agent at the same instant.
 */
export function markResumed(entry: LedgerEntry, when: number, now: number): LedgerEntry {
  return { ...entry, state: "retrying", nextRetryAt: when, updatedAt: now };
}

/** Entries whose schedule is due at `now` and whose state still wants an attempt. */
export function dueEntries(ledger: RunLedger, now: number): LedgerEntry[] {
  return Object.values(ledger.entries).filter(
    (e) =>
      (e.state === "retrying" || e.state === "paused-usage-limit") &&
      e.nextRetryAt !== null &&
      e.nextRetryAt <= now,
  );
}

/* ------------------------------------------------------------------ *
 * Persistence (the only impure part)
 * ------------------------------------------------------------------ */

export function loadLedger(runId: string): RunLedger | null {
  return readJson<RunLedger | null>(paths.ledgerFile(runId), null);
}

export function saveLedger(ledger: RunLedger): void {
  writeJsonAtomic(paths.ledgerFile(ledger.runId), ledger);
}

/** Run ids with a persisted ledger — how state survives a daemon restart. */
export function listLedgerRunIds(): string[] {
  try {
    return readdirSync(paths.ledgerDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/** Load every persisted ledger, skipping any that no longer parse. */
export function loadAllLedgers(): Map<string, RunLedger> {
  const out = new Map<string, RunLedger>();
  for (const runId of listLedgerRunIds()) {
    const ledger = loadLedger(runId);
    if (ledger && typeof ledger.runId === "string" && ledger.entries) out.set(ledger.runId, ledger);
  }
  return out;
}
