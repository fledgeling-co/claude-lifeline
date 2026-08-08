/**
 * Ledger evals — the retry state machine, and the persistence that makes it survive a restart.
 *
 * The ledger is the only place that remembers a failure across process boundaries, so the two
 * things worth proving are: the class→state mapping never blind-retries something terminal, and
 * a saved ledger round-trips byte-identically.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BackoffPolicy } from "../../src/shared/backoff.js";
import { DEFAULT_POLICY } from "../../src/shared/backoff.js";
import type { Classification, ErrorClass } from "../../src/shared/classifier.js";
import { classify } from "../../src/shared/classifier.js";
import { paths } from "../../src/shared/paths.js";
import type { AgentState, LedgerEntry } from "../../src/shared/types.js";
import {
  dueEntries,
  emptyLedger,
  getEntry,
  isActive,
  isTerminal,
  listLedgerRunIds,
  loadAllLedgers,
  loadLedger,
  markDone,
  markPaused,
  markResumed,
  newEntry,
  rearmAfterAttempt,
  saveLedger,
  scheduleNext,
  stateForClass,
  upsertEntry,
} from "../../src/daemon/ledger.js";
import {
  BODY_AUTH,
  BODY_OVERLOADED,
  BODY_PROMPT_TOO_LONG,
  BODY_RATE_LIMIT,
  BODY_USAGE_LIMIT,
} from "../support/mock-upstream.js";
import { useTempEnv } from "../support/tmp.js";

const NOW = 1_700_000_000_000;
const POLICY: BackoffPolicy = { baseMs: 1000, capMs: 60_000, maxAttempts: 30, maxDurationMs: 3_600_000 };

/** rng that always returns the same point in the jitter window, so delays are exact. */
const rngHalf = (): number => 0.5;
const rngZero = (): number => 0;

function freshEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ...newEntry({ key: "k-1", runId: "wf_test", item: "LL-0001", agentId: "a1", now: NOW }),
    ...overrides,
  };
}

function classOf(input: Parameters<typeof classify>[0]): Classification {
  return classify(input);
}

/** Narrowing helper so assertions read as assertions rather than as optional chaining. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

describe("stateForClass", () => {
  const table: { cls: ErrorClass; expected: AgentState }[] = [
    { cls: "RATE_LIMIT", expected: "retrying" },
    { cls: "OVERLOADED", expected: "retrying" },
    { cls: "CONN", expected: "retrying" },
    { cls: "USAGE_LIMIT", expected: "paused-usage-limit" },
    { cls: "CONTEXT", expected: "failed-terminal" },
    { cls: "AUTH", expected: "failed-terminal" },
    { cls: "UNKNOWN", expected: "failed-terminal" },
  ];

  it.each(table)("$cls -> $expected", ({ cls, expected }) => {
    expect(stateForClass(cls, false)).toBe(expected);
  });

  it("an exhausted schedule is failed-terminal regardless of how retryable the class is", () => {
    for (const { cls } of table) expect(stateForClass(cls, true)).toBe("failed-terminal");
  });
});

describe("isActive / isTerminal", () => {
  it("partitions the state space with no overlap and no gap", () => {
    const all: AgentState[] = [
      "retrying",
      "paused-offline",
      "paused-usage-limit",
      "paused-manual",
      "failed-terminal",
      "done",
    ];
    for (const state of all) expect(isActive(state)).toBe(!isTerminal(state));
  });
});

describe("scheduleNext — transitions per class", () => {
  it("schedules a retry for a 429 and lands in `retrying`", () => {
    const next = scheduleNext(freshEntry(), classOf({ status: 429, message: BODY_RATE_LIMIT }), POLICY, NOW, {
      rng: rngHalf,
    });
    expect(next.state).toBe("retrying");
    expect(next.lastClass).toBe("RATE_LIMIT");
    expect(next.attempts).toBe(1);
    // attempt index 0 -> ceiling 1000 -> 0.5 * 1000
    expect(next.nextRetryAt).toBe(NOW + 500);
    expect(next.firstFailureAt).toBe(NOW);
  });

  it("schedules a retry for a 503 overload", () => {
    const next = scheduleNext(freshEntry(), classOf({ status: 503, message: BODY_OVERLOADED }), POLICY, NOW, {
      rng: rngHalf,
    });
    expect(next.state).toBe("retrying");
    expect(next.lastClass).toBe("OVERLOADED");
    expect(next.nextRetryAt).toBe(NOW + 500);
  });

  it("schedules a retry for a transport failure", () => {
    const next = scheduleNext(
      freshEntry(),
      classOf({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:4000" }),
      POLICY,
      NOW,
      { rng: rngHalf },
    );
    expect(next.state).toBe("retrying");
    expect(next.lastClass).toBe("CONN");
    expect(next.nextRetryAt).toBe(NOW + 500);
  });

  it("parks a usage limit but still books the next probe (never a hard sleep to one reset)", () => {
    const next = scheduleNext(freshEntry(), classOf({ status: 429, message: BODY_USAGE_LIMIT }), POLICY, NOW, {
      rng: rngHalf,
    });
    expect(next.state).toBe("paused-usage-limit");
    expect(next.lastClass).toBe("USAGE_LIMIT");
    expect(next.nextRetryAt).toBe(NOW + 500);
    // A parked entry is still due when its schedule comes round — that is what lets a rotating
    // proxy account be picked up as soon as one frees.
    const ledger = upsertEntry(
      emptyLedger({ runId: "wf_test", project: "p", sessionId: "s", scriptPath: null, args: null, now: NOW }),
      next,
    );
    expect(dueEntries(ledger, NOW + 500)).toHaveLength(1);
  });

  it("marks a context overflow terminal with no schedule at all", () => {
    const next = scheduleNext(
      freshEntry(),
      classOf({ status: 400, message: BODY_PROMPT_TOO_LONG }),
      POLICY,
      NOW,
      { rng: rngHalf },
    );
    expect(next.state).toBe("failed-terminal");
    expect(next.lastClass).toBe("CONTEXT");
    expect(next.nextRetryAt).toBeNull();
    expect(next.attempts).toBe(1);
  });

  it("marks an auth failure terminal", () => {
    const next = scheduleNext(freshEntry(), classOf({ status: 401, message: BODY_AUTH }), POLICY, NOW, {
      rng: rngHalf,
    });
    expect(next.state).toBe("failed-terminal");
    expect(next.lastClass).toBe("AUTH");
    expect(next.nextRetryAt).toBeNull();
  });

  it("honours Retry-After verbatim when scheduling", () => {
    const next = scheduleNext(
      freshEntry(),
      classOf({ status: 429, message: BODY_RATE_LIMIT, retryAfterSeconds: 42 }),
      POLICY,
      NOW,
      { rng: rngHalf },
    );
    expect(next.nextRetryAt).toBe(NOW + 42_000);
  });

  it("records the raw error text for the status surface", () => {
    const next = scheduleNext(freshEntry(), classOf({ status: 429 }), POLICY, NOW, {
      rng: rngHalf,
      lastError: "API Error: 429 rate limited",
    });
    expect(next.lastError).toBe("API Error: 429 rate limited");
  });

  it("never mutates the entry it was given", () => {
    const entry = freshEntry();
    const snapshot = structuredClone(entry);
    scheduleNext(entry, classOf({ status: 429 }), POLICY, NOW, { rng: rngHalf });
    expect(entry).toEqual(snapshot);
  });
});

describe("scheduleNext — attempts and exhaustion", () => {
  it("increments attempts on every observed failure", () => {
    let entry = freshEntry();
    const failure = classOf({ status: 503, message: BODY_OVERLOADED });
    for (let i = 1; i <= 5; i += 1) {
      entry = scheduleNext(entry, failure, POLICY, NOW + i, { rng: rngZero });
      expect(entry.attempts).toBe(i);
      expect(entry.state).toBe("retrying");
    }
    // firstFailureAt anchors the duration budget and never moves.
    expect(entry.firstFailureAt).toBe(NOW + 1);
  });

  it("goes failed-terminal only once the attempt cap is genuinely reached", () => {
    // `attempts` is the failure counter, so the 0-based index handed to the backoff is the
    // PRE-increment value: with maxAttempts 3 the third failure still schedules, the fourth
    // is the one that finds the schedule exhausted.
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 10_000, maxAttempts: 3 };
    const failure = classOf({ status: 429, message: BODY_RATE_LIMIT });
    let entry = freshEntry();

    for (const expectedAttempts of [1, 2, 3]) {
      entry = scheduleNext(entry, failure, policy, NOW, { rng: rngZero });
      expect(entry.attempts).toBe(expectedAttempts);
      expect(entry.state).toBe("retrying");
      expect(entry.nextRetryAt).toBe(NOW);
    }

    entry = scheduleNext(entry, failure, policy, NOW, { rng: rngZero });
    expect(entry.attempts).toBe(4);
    expect(entry.state).toBe("failed-terminal");
    expect(entry.nextRetryAt).toBeNull();
  });

  it("goes failed-terminal when the wall-clock budget is spent, however few the attempts", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 10_000, maxAttempts: 30, maxDurationMs: 5_000 };
    const entry = freshEntry({ attempts: 1, firstFailureAt: NOW });
    const next = scheduleNext(entry, classOf({ status: 429 }), policy, NOW + 5_001, { rng: rngZero });
    expect(next.state).toBe("failed-terminal");
    expect(next.nextRetryAt).toBeNull();
    expect(next.attempts).toBe(2);
  });

  it("keeps retrying while the budget still has room", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 10_000, maxAttempts: 30, maxDurationMs: 5_000 };
    const entry = freshEntry({ attempts: 1, firstFailureAt: NOW });
    const next = scheduleNext(entry, classOf({ status: 429 }), policy, NOW + 1_000, { rng: rngZero });
    expect(next.state).toBe("retrying");
    expect(next.nextRetryAt).toBe(NOW + 1_000);
  });
});

describe("rearmAfterAttempt", () => {
  it("books the next probe without counting a new failure", () => {
    const entry = freshEntry({ attempts: 2, state: "retrying", firstFailureAt: NOW, nextRetryAt: NOW });
    const rearmed = rearmAfterAttempt(entry, POLICY, NOW, { rng: rngHalf });
    expect(rearmed.attempts).toBe(2);
    // attempt index 2 -> ceiling 4000 -> 0.5 * 4000
    expect(rearmed.nextRetryAt).toBe(NOW + 2_000);
    expect(rearmed.state).toBe("retrying");
  });

  it("keeps a usage-limit park probing", () => {
    const entry = freshEntry({ attempts: 0, state: "paused-usage-limit", firstFailureAt: NOW, nextRetryAt: NOW });
    const rearmed = rearmAfterAttempt(entry, POLICY, NOW, { rng: rngHalf });
    expect(rearmed.state).toBe("paused-usage-limit");
    expect(rearmed.nextRetryAt).toBe(NOW + 500);
  });

  it("clears the schedule for a state that no longer wants attempts", () => {
    for (const state of ["done", "failed-terminal", "paused-manual", "paused-offline"] as AgentState[]) {
      const rearmed = rearmAfterAttempt(freshEntry({ state, nextRetryAt: NOW }), POLICY, NOW, { rng: rngHalf });
      expect(rearmed.state).toBe(state);
      expect(rearmed.nextRetryAt).toBeNull();
    }
  });

  it("parks terminally when the entry has outlived the duration budget", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 10_000, maxAttempts: 30, maxDurationMs: 5_000 };
    const entry = freshEntry({ attempts: 3, state: "retrying", firstFailureAt: NOW });
    const rearmed = rearmAfterAttempt(entry, policy, NOW + 6_000, { rng: rngZero });
    expect(rearmed.state).toBe("failed-terminal");
    expect(rearmed.nextRetryAt).toBeNull();
  });
});

describe("markDone / markPaused / markResumed / dueEntries", () => {
  it("markDone ends recovery", () => {
    const done = markDone(freshEntry({ state: "retrying", nextRetryAt: NOW + 1000 }), NOW);
    expect(done.state).toBe("done");
    expect(done.nextRetryAt).toBeNull();
  });

  it("markPaused keeps the attempt count and drops the schedule", () => {
    const paused = markPaused(freshEntry({ attempts: 4, nextRetryAt: NOW + 10 }), "paused-manual", NOW);
    expect(paused.state).toBe("paused-manual");
    expect(paused.attempts).toBe(4);
    expect(paused.nextRetryAt).toBeNull();
  });

  it("markResumed re-arms at the requested instant", () => {
    const resumed = markResumed(freshEntry({ state: "paused-offline" }), NOW + 250, NOW);
    expect(resumed.state).toBe("retrying");
    expect(resumed.nextRetryAt).toBe(NOW + 250);
  });

  it("dueEntries returns only scheduled, still-wanted attempts", () => {
    let ledger = emptyLedger({
      runId: "wf_test",
      project: "p",
      sessionId: "s",
      scriptPath: null,
      args: null,
      now: NOW,
    });
    ledger = upsertEntry(ledger, freshEntry({ key: "due", state: "retrying", nextRetryAt: NOW }));
    ledger = upsertEntry(ledger, freshEntry({ key: "later", state: "retrying", nextRetryAt: NOW + 1 }));
    ledger = upsertEntry(ledger, freshEntry({ key: "parked", state: "paused-usage-limit", nextRetryAt: NOW }));
    ledger = upsertEntry(ledger, freshEntry({ key: "manual", state: "paused-manual", nextRetryAt: NOW }));
    ledger = upsertEntry(ledger, freshEntry({ key: "dead", state: "failed-terminal", nextRetryAt: NOW }));
    ledger = upsertEntry(ledger, freshEntry({ key: "finished", state: "done", nextRetryAt: NOW }));
    ledger = upsertEntry(ledger, freshEntry({ key: "unscheduled", state: "retrying", nextRetryAt: null }));

    expect(dueEntries(ledger, NOW).map((e) => e.key).sort()).toEqual(["due", "parked"]);
  });
});

describe("upsertEntry / getEntry", () => {
  it("inserts by key, replaces on repeat, and leaves the input ledger untouched", () => {
    const base = emptyLedger({
      runId: "wf_test",
      project: "p",
      sessionId: "s",
      scriptPath: null,
      args: null,
      now: NOW,
    });
    const first = upsertEntry(base, freshEntry({ key: "k", attempts: 1, updatedAt: NOW + 1 }));
    const second = upsertEntry(first, freshEntry({ key: "k", attempts: 2, updatedAt: NOW + 2 }));

    expect(Object.keys(base.entries)).toHaveLength(0);
    expect(Object.keys(second.entries)).toEqual(["k"]);
    expect(getEntry(second, "k")?.attempts).toBe(2);
    expect(getEntry(second, "missing")).toBeNull();
    expect(second.updatedAt).toBe(NOW + 2);
  });
});

describe("persistence", () => {
  const tmp = useTempEnv();

  it("round-trips a ledger through disk", () => {
    expect(tmp.env.home).toBeTruthy();
    let ledger = emptyLedger({
      runId: "wf_persist",
      project: "-Users-luke-Dev-lifeline",
      sessionId: "session-1",
      scriptPath: "/tmp/scripts/fleet-wf_persist.js",
      args: { items: ["LL-0001"] },
      now: NOW,
    });
    ledger = upsertEntry(
      ledger,
      scheduleNext(freshEntry(), classOf({ status: 429, message: BODY_RATE_LIMIT }), POLICY, NOW, {
        rng: rngHalf,
        lastError: "API Error: 429",
      }),
    );

    saveLedger(ledger);
    expect(existsSync(paths.ledgerFile("wf_persist"))).toBe(true);
    expect(loadLedger("wf_persist")).toEqual(ledger);
  });

  it("returns null for a run with no ledger", () => {
    expect(loadLedger("wf_never_seen")).toBeNull();
  });

  it("lists and loads every persisted ledger — how state survives a daemon restart", () => {
    for (const runId of ["wf_a", "wf_b"]) {
      saveLedger(
        upsertEntry(
          emptyLedger({ runId, project: "p", sessionId: "s", scriptPath: null, args: null, now: NOW }),
          freshEntry({ key: `${runId}-k`, attempts: 3, state: "retrying", nextRetryAt: NOW + 500 }),
        ),
      );
    }

    expect(listLedgerRunIds().sort()).toEqual(["wf_a", "wf_b"]);

    const all = loadAllLedgers();
    expect(all.size).toBe(2);
    expect(getEntry(must(all.get("wf_a"), "ledger wf_a"), "wf_a-k")?.attempts).toBe(3);
    expect(getEntry(must(all.get("wf_b"), "ledger wf_b"), "wf_b-k")?.state).toBe("retrying");
  });

  it("tolerates an empty ledger directory", () => {
    expect(listLedgerRunIds()).toEqual([]);
    expect(loadAllLedgers().size).toBe(0);
  });
});

describe("policy defaults", () => {
  it("the shipped recovery policy is the one the ledger schedules against", () => {
    const next = scheduleNext(freshEntry(), classOf({ status: 429 }), DEFAULT_POLICY, NOW, { rng: rngZero });
    expect(next.state).toBe("retrying");
    expect(next.nextRetryAt).toBe(NOW);
  });
});

/**
 * Regression cover for the gap that made lifeline's headline promise silently untrue:
 * `stateForClass` maps STALL to "stalled" and its comment says that state is "recovered by a
 * scheduled relaunch (a nudge) like any retryable loss", but `dueEntries` admitted only
 * "retrying" and "paused-usage-limit". Every stalled agent was therefore diagnosed, given a
 * nextRetryAt, and dropped before planRecovery ever saw it. Observed in the field on a run
 * whose agent had been dead for 91 minutes with a retry scheduled 12 minutes earlier.
 */
describe("dueEntries covers every recoverable state", () => {
  function entry(over: Partial<LedgerEntry>): LedgerEntry {
    return {
      key: "k",
      runId: "wf_1",
      item: "DIO-0133",
      agentId: "a1",
      attempts: 1,
      nextRetryAt: 1_000,
      firstFailureAt: 0,
      lastClass: "STALL",
      lastError: "stalled 91m",
      state: "stalled",
      updatedAt: 0,
      ...over,
    } as LedgerEntry;
  }
  const ledgerOf = (...es: LedgerEntry[]) => ({
    ...emptyLedger("wf_1", "-proj", "sess"),
    entries: Object.fromEntries(es.map((e, i) => [`k${i}`, { ...e, key: `k${i}` }])),
  });

  it("returns a stalled entry whose retry is due", () => {
    const due = dueEntries(ledgerOf(entry({})), 2_000);
    expect(due).toHaveLength(1);
    expect(due[0]?.state).toBe("stalled");
  });

  it("still returns retrying and usage-limit entries", () => {
    const due = dueEntries(
      ledgerOf(entry({ state: "retrying" }), entry({ state: "paused-usage-limit" })),
      2_000,
    );
    expect(due.map((e) => e.state).sort()).toEqual(["paused-usage-limit", "retrying"]);
  });

  it("never returns a state that must not be blind-retried", () => {
    const states: AgentState[] = ["done", "failed-terminal", "paused-manual", "paused-offline"];
    const due = dueEntries(ledgerOf(...states.map((state) => entry({ state }))), 2_000);
    expect(due).toEqual([]);
  });

  it("does not return a stalled entry before its retry time", () => {
    expect(dueEntries(ledgerOf(entry({ nextRetryAt: 9_000 })), 2_000)).toEqual([]);
  });

  it("does not return a stalled entry with no retry scheduled", () => {
    expect(dueEntries(ledgerOf(entry({ nextRetryAt: null })), 2_000)).toEqual([]);
  });
});
