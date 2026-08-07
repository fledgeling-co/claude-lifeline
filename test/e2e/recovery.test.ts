/**
 * Recovery e2e — spec acceptance criteria 2, 3 and 4, end to end over a synthesised run tree.
 *
 * A workflow run directory is written to disk exactly as Claude Code lays one out, containing
 * the silent loss the runtime reports as "completed": an agent with a `started` line, no
 * `result`, and a transcript that ends in an apiError. The real daemon then scans it, keeps a
 * ledger, and drives recovery — with the spawn injected, so nothing ever launches `claude`.
 *
 * The clock is injected rather than faked globally: the daemon's scheduling is a pure function
 * of `now`, so stepping a variable is both deterministic and honest about what is being tested.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/shared/config.js";
import type { LifelineConfig } from "../../src/shared/config.js";
import { readJson } from "../../src/shared/io.js";
import { paths } from "../../src/shared/paths.js";
import type { RunAgentView } from "../../src/daemon/index.js";
import type { LedgerEntry, StatusSnapshot } from "../../src/shared/types.js";
import { computeRunState, startDaemon } from "../../src/daemon/index.js";
import type { DaemonHandle } from "../../src/daemon/index.js";
import { scanRunDir } from "../../src/daemon/journal.js";
import { getEntry, loadAllLedgers, loadLedger } from "../../src/daemon/ledger.js";
import { buildRelaunchArgv, isDue, planRecovery } from "../../src/daemon/recovery.js";
import type { ActiveRecoveryPlan, SpawnFn } from "../../src/daemon/recovery.js";
import { renderStatus } from "../../src/cli/render.js";
import { useTempEnv } from "../support/tmp.js";

const PROJECT = "-Users-luke-Dev-lifeline";
const SESSION = "9f1c2b7d-0000-4000-8000-000000000001";
const CWD = "/Users/luke/Dev/lifeline";

/** Keys stand in for the runtime's sha256 prompt-chain keys; only their identity matters. */
const KEY = {
  alphaHealthy: "a".repeat(64),
  alphaLost: "b".repeat(64),
  alphaLive: "c".repeat(64),
  betaHealthy: "d".repeat(64),
  betaTerminal: "e".repeat(64),
} as const;

/** The 429 tail the daemon must read as a hot, retryable loss. */
const RATE_LIMIT_TAIL =
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your limit"}}';

/** The context-overflow tail the daemon must read as terminal and never blind-retry. */
const PROMPT_TOO_LONG_TAIL = "API Error: Prompt is too long: 250000 tokens > 200000 maximum";

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function normalLine(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    cwd: CWD,
    message: { model: "claude-opus-4", content: [{ type: "text", text }] },
  };
}

function apiErrorLine(status: number, text: string, errorCode: string): Record<string, unknown> {
  // The exact shape the runtime writes on an API failure (FINDINGS.md "API error path").
  return {
    type: "assistant",
    cwd: CWD,
    isApiErrorMessage: true,
    apiErrorStatus: status,
    error: errorCode,
    message: { model: "<synthetic>", content: [{ type: "text", text }] },
  };
}

interface RunFixture {
  runDir: string;
  runId: string;
  scriptPath: string;
}

/**
 * Write one wf_<id> run directory plus its sibling snapshot, matching the documented layout:
 *   <projects>/<project>/<session>/subagents/workflows/wf_x/{journal.jsonl,agent-*.jsonl}
 *   <projects>/<project>/<session>/workflows/wf_x.json
 */
function writeRun(
  projects: string,
  runId: string,
  spec: {
    journal: Record<string, unknown>[];
    transcripts: Record<string, Record<string, unknown>[]>;
    progress?: { agentId: string; label: string }[];
  },
): RunFixture {
  const sessionDir = join(projects, PROJECT, SESSION);
  const runDir = join(sessionDir, "subagents", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });

  writeFileSync(join(runDir, "journal.jsonl"), jsonl(spec.journal), "utf8");
  for (const [agentId, lines] of Object.entries(spec.transcripts)) {
    writeFileSync(join(runDir, `agent-${agentId}.jsonl`), jsonl(lines), "utf8");
  }

  const scriptPath = join(sessionDir, "scripts", `fleet-${runId}.js`);
  writeFileSync(
    join(sessionDir, "workflows", `${runId}.json`),
    JSON.stringify({
      runId,
      scriptPath,
      args: { items: ["LL-0042", "LL-0043"] },
      workflowProgress: spec.progress ?? [],
    }),
    "utf8",
  );

  return { runDir, runId, scriptPath };
}

/** wf_alpha: one healthy agent, one lost to a 429, one still live. Run-level => warning. */
function writeAlpha(projects: string): RunFixture {
  return writeRun(projects, "wf_alpha", {
    journal: [
      { type: "started", key: KEY.alphaHealthy, agentId: "a1" },
      { type: "result", key: KEY.alphaHealthy, agentId: "a1", result: "done" },
      { type: "started", key: KEY.alphaLost, agentId: "a2" },
      { type: "started", key: KEY.alphaLive, agentId: "a3" },
    ],
    transcripts: {
      a1: [normalLine("Working on LL-0041."), normalLine("Finished LL-0041.")],
      a2: [
        normalLine("Starting LL-0042: implement the ledger."),
        normalLine("Reading src/daemon/ledger.ts"),
        apiErrorLine(429, RATE_LIMIT_TAIL, "rate_limit"),
      ],
      a3: [normalLine("Starting LL-0043: wire the CLI."), normalLine("Still editing src/cli/index.ts")],
    },
    progress: [
      { agentId: "a2", label: "LL-0042 implement the ledger" },
      { agentId: "a3", label: "LL-0043 wire the CLI" },
    ],
  });
}

/** wf_beta: one healthy agent and one lost terminally. No live siblings => completed-with-failures. */
function writeBeta(projects: string): RunFixture {
  return writeRun(projects, "wf_beta", {
    journal: [
      { type: "started", key: KEY.betaHealthy, agentId: "b1" },
      { type: "result", key: KEY.betaHealthy, agentId: "b1", result: "done" },
      { type: "started", key: KEY.betaTerminal, agentId: "b2" },
    ],
    transcripts: {
      b1: [normalLine("LL-0050 complete.")],
      b2: [normalLine("Starting LL-0051."), apiErrorLine(400, PROMPT_TOO_LONG_TAIL, "invalid_request_error")],
    },
    progress: [{ agentId: "b2", label: "LL-0051 migrate the fixtures" }],
  });
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string | undefined;
}

function recordingSpawn(): { fn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return { pid: 4242 + calls.length };
  };
  return { fn, calls };
}

function testConfig(over: Partial<LifelineConfig> = {}): LifelineConfig {
  return {
    ...DEFAULT_CONFIG,
    // Everything past this window with no transcript write counts as "not live".
    liveWindowMs: 1_000,
    daemonTickMs: 1_000_000, // the interval never fires; tests call tick() directly
    recovery: { baseMs: 1_000, capMs: 60_000, maxAttempts: 30, maxDurationMs: 3_600_000 },
    ...over,
  };
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

describe("recovery e2e", () => {
  const tmp = useTempEnv();
  const handles: DaemonHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) await handles.pop()?.stop();
  });

  function start(cfg: LifelineConfig, deps: Parameters<typeof startDaemon>[1]): DaemonHandle {
    const handle = startDaemon(cfg, deps);
    handles.push(handle);
    return handle;
  }

  it("detects the lost agent from the journal alone, and leaves the live sibling alone", () => {
    const alpha = writeAlpha(tmp.env.projects);
    const cfg = testConfig();
    // Far enough past every transcript's mtime that the quiet ones are provably not live.
    const now = Date.now() + 60_000;

    const scan = must(scanRunDir(alpha.runDir, { now, liveWindowMs: cfg.liveWindowMs }), "scan");

    expect(scan.runId).toBe("wf_alpha");
    expect(scan.project).toBe(PROJECT);
    expect(scan.sessionId).toBe(SESSION);
    expect(scan.scriptPath).toBe(alpha.scriptPath);
    expect(scan.args).toEqual({ items: ["LL-0042", "LL-0043"] });
    expect(scan.cwd).toBe(CWD);
    expect(scan.completedAgents).toBe(1);
    expect(scan.resultKeys).toEqual([KEY.alphaHealthy]);

    expect(scan.lost).toHaveLength(1);
    const lost = must(scan.lost[0], "lost agent");
    expect(lost.agentId).toBe("a2");
    expect(lost.key).toBe(KEY.alphaLost);
    expect(lost.item).toBe("LL-0042");
    expect(lost.classification.class).toBe("RATE_LIMIT");
    expect(lost.classification.retryable).toBe(true);

    // a3 has no api-error tail, so it is still counted as live rather than lost.
    expect(scan.liveAgents).toBe(1);
  });

  it("does not call an agent lost while its transcript is still inside the live window", () => {
    const alpha = writeAlpha(tmp.env.projects);
    // `now` at the file's own mtime: nothing has been quiet long enough to be declared dead.
    const scan = must(scanRunDir(alpha.runDir, { now: Date.now(), liveWindowMs: 300_000 }), "scan");
    expect(scan.lost).toHaveLength(0);
    expect(scan.liveAgents).toBe(2);
  });

  it("plans a relaunch that resumes THIS run rather than starting new work", () => {
    const alpha = writeAlpha(tmp.env.projects);
    const cfg = testConfig();
    const now = Date.now() + 60_000;
    const scan = must(scanRunDir(alpha.runDir, { now, liveWindowMs: cfg.liveWindowMs }), "scan");
    const lost = must(scan.lost[0], "lost agent");

    const entry: LedgerEntry = {
      key: lost.key,
      runId: scan.runId,
      item: lost.item,
      agentId: lost.agentId,
      attempts: 1,
      nextRetryAt: now,
      firstFailureAt: now,
      lastClass: "RATE_LIMIT",
      lastError: lost.errorText,
      state: "retrying",
      updatedAt: now,
    };

    const plan = planRecovery({ run: scan, finding: lost, entry, now });
    expect(plan.kind).toBe("relaunch");
    expect(isDue(plan, now)).toBe(true);

    const active = plan as ActiveRecoveryPlan;
    expect(active.resumeFromRunId).toBe("wf_alpha");
    expect(active.runId).toBe("wf_alpha");
    expect(active.sessionId).toBe(SESSION);
    expect(active.cwd).toBe(CWD);
    expect(active.scriptPath).toBe(alpha.scriptPath);

    const argv = buildRelaunchArgv(active);
    expect(argv[0]).toBe("--resume");
    expect(argv[1]).toBe(SESSION);
    expect(argv[2]).toBe("-p");
    const prompt = must(argv[3], "resume prompt");
    expect(prompt).toContain('resumeFromRunId="wf_alpha"');
    expect(prompt).toContain(alpha.scriptPath);
    expect(prompt).toContain("LL-0042");
    expect(prompt).toContain("Do not start new work");
  });

  it("refuses to plan anything for a terminal or paused entry", () => {
    const alpha = writeAlpha(tmp.env.projects);
    const now = Date.now() + 60_000;
    const scan = must(scanRunDir(alpha.runDir, { now, liveWindowMs: 1_000 }), "scan");
    const lost = must(scan.lost[0], "lost agent");
    const base: LedgerEntry = {
      key: lost.key,
      runId: scan.runId,
      item: lost.item,
      agentId: lost.agentId,
      attempts: 1,
      nextRetryAt: now,
      firstFailureAt: now,
      lastClass: "CONTEXT",
      lastError: lost.errorText,
      state: "failed-terminal",
      updatedAt: now,
    };

    for (const state of ["failed-terminal", "done", "paused-manual", "paused-offline"] as const) {
      const plan = planRecovery({ run: scan, finding: lost, entry: { ...base, state }, now });
      expect(plan.kind).toBe("none");
    }
    // Even a live state plans nothing without a schedule.
    expect(
      planRecovery({ run: scan, finding: lost, entry: { ...base, state: "retrying", nextRetryAt: null }, now })
        .kind,
    ).toBe("none");
  });

  it("drives the whole loop: detect -> ledger -> spawn stub -> idempotent rescan", async () => {
    writeAlpha(tmp.env.projects);
    const alphaDir = join(tmp.env.projects, PROJECT, SESSION, "subagents", "workflows", "wf_alpha");
    const cfg = testConfig();
    const { fn: spawn, calls } = recordingSpawn();

    let clock = Date.now() + 60_000;
    const daemon = start(cfg, {
      now: () => clock,
      rng: () => 0.25, // attempt 0 -> ceiling 1000 -> a 250ms schedule
      watch: false,
      relaunch: { spawn, command: "claude-stub" },
    });

    // --- tick 1: the loss is detected and scheduled, but is not yet due.
    daemon.markDirty(alphaDir);
    await daemon.tick();

    const afterFirst = must(loadLedger("wf_alpha"), "ledger after first tick");
    const entry = must(getEntry(afterFirst, KEY.alphaLost), "ledger entry");
    expect(entry.state).toBe("retrying");
    expect(entry.attempts).toBe(1);
    expect(entry.lastClass).toBe("RATE_LIMIT");
    expect(entry.item).toBe("LL-0042");
    expect(entry.agentId).toBe("a2");
    expect(entry.nextRetryAt).toBe(clock + 250);
    expect(calls).toHaveLength(0);
    // The healthy and live agents are not in the ledger at all.
    expect(Object.keys(afterFirst.entries)).toEqual([KEY.alphaLost]);

    // --- tick 2: the schedule comes due and recovery fires exactly once.
    clock += 300;
    daemon.markDirty(alphaDir);
    await daemon.tick();

    expect(calls).toHaveLength(1);
    const call = must(calls[0], "spawn call");
    expect(call.command).toBe("claude-stub"); // injected, so the real `claude` never ran
    expect(call.cwd).toBe(CWD);
    expect(call.args[0]).toBe("--resume");
    expect(call.args[1]).toBe(SESSION);
    expect(must(call.args[3], "prompt")).toContain('resumeFromRunId="wf_alpha"');

    // --- tick 3: rescanning the same, unchanged transcript must not inflate anything.
    daemon.markDirty(alphaDir);
    await daemon.tick();

    const afterThird = must(loadLedger("wf_alpha"), "ledger after third tick");
    const stable = must(getEntry(afterThird, KEY.alphaLost), "ledger entry");
    expect(stable.attempts).toBe(1); // no new failure was observed, so no new attempt counted
    expect(calls).toHaveLength(1); // and the rearmed schedule is not yet due again
    expect(stable.nextRetryAt).toBe(clock + 500); // attempt 1 -> ceiling 2000 -> 0.25
  });

  it("survives a daemon restart: the ledger reloads and a rescan does not re-count the failure", async () => {
    writeAlpha(tmp.env.projects);
    const alphaDir = join(tmp.env.projects, PROJECT, SESSION, "subagents", "workflows", "wf_alpha");
    const cfg = testConfig();
    let clock = Date.now() + 60_000;

    const first = recordingSpawn();
    const daemonA = start(cfg, {
      now: () => clock,
      rng: () => 0.25,
      watch: false,
      relaunch: { spawn: first.fn, command: "claude-stub" },
    });
    daemonA.markDirty(alphaDir);
    await daemonA.tick();
    clock += 300;
    daemonA.markDirty(alphaDir);
    await daemonA.tick();
    await daemonA.stop();

    expect(first.calls).toHaveLength(1);
    const persisted = must(getEntry(must(loadLedger("wf_alpha"), "ledger"), KEY.alphaLost), "entry");
    expect(persisted.attempts).toBe(1);

    // A brand-new daemon process reads the ledger back off disk.
    const second = recordingSpawn();
    const daemonB = start(cfg, {
      now: () => clock,
      rng: () => 0.25,
      watch: false,
      relaunch: { spawn: second.fn, command: "claude-stub" },
    });

    expect(loadAllLedgers().has("wf_alpha")).toBe(true);

    daemonB.markDirty(alphaDir);
    await daemonB.tick();

    const reloaded = must(getEntry(must(loadLedger("wf_alpha"), "ledger"), KEY.alphaLost), "entry");
    expect(reloaded.attempts).toBe(1); // the same stale transcript must not look like a new failure
    expect(reloaded.state).toBe("retrying");
  });

  it("marks an agent done once a real result lands, and never before", async () => {
    const alpha = writeAlpha(tmp.env.projects);
    const cfg = testConfig();
    const { fn: spawn } = recordingSpawn();
    let clock = Date.now() + 60_000;

    const daemon = start(cfg, {
      now: () => clock,
      rng: () => 0.25,
      watch: false,
      relaunch: { spawn, command: "claude-stub" },
    });
    daemon.markDirty(alpha.runDir);
    await daemon.tick();
    expect(must(getEntry(must(loadLedger("wf_alpha"), "ledger"), KEY.alphaLost), "entry").state).toBe(
      "retrying",
    );

    // The relaunched agent journals a result — the only evidence recovery worked.
    writeFileSync(
      join(alpha.runDir, "journal.jsonl"),
      jsonl([
        { type: "started", key: KEY.alphaHealthy, agentId: "a1" },
        { type: "result", key: KEY.alphaHealthy, agentId: "a1", result: "done" },
        { type: "started", key: KEY.alphaLost, agentId: "a2" },
        { type: "result", key: KEY.alphaLost, agentId: "a2", result: "recovered" },
        { type: "started", key: KEY.alphaLive, agentId: "a3" },
      ]),
      "utf8",
    );

    clock += 1_000;
    daemon.markDirty(alpha.runDir);
    await daemon.tick();

    const recovered = must(getEntry(must(loadLedger("wf_alpha"), "ledger"), KEY.alphaLost), "entry");
    expect(recovered.state).toBe("done");
    expect(recovered.nextRetryAt).toBeNull();
  });

  it("never schedules a retry for a context overflow — it is surfaced as terminal", async () => {
    const beta = writeBeta(tmp.env.projects);
    const cfg = testConfig();
    const { fn: spawn, calls } = recordingSpawn();
    const clock = Date.now() + 60_000;

    const daemon = start(cfg, {
      now: () => clock,
      rng: () => 0,
      watch: false,
      relaunch: { spawn, command: "claude-stub" },
    });
    daemon.markDirty(beta.runDir);
    await daemon.tick();
    await daemon.tick();

    const entry = must(getEntry(must(loadLedger("wf_beta"), "ledger"), KEY.betaTerminal), "entry");
    expect(entry.lastClass).toBe("CONTEXT");
    expect(entry.state).toBe("failed-terminal");
    expect(entry.nextRetryAt).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("rolls a per-agent failure up to a run-level warning, and a finished run to completed-with-failures", async () => {
    const alpha = writeAlpha(tmp.env.projects);
    const beta = writeBeta(tmp.env.projects);
    const cfg = testConfig();
    const { fn: spawn } = recordingSpawn();
    const clock = Date.now() + 60_000;

    const daemon = start(cfg, {
      now: () => clock,
      rng: () => 0.25,
      watch: false,
      relaunch: { spawn, command: "claude-stub" },
    });
    daemon.markDirty(alpha.runDir);
    daemon.markDirty(beta.runDir);
    await daemon.tick();

    const snapshot = must(readJson<StatusSnapshot | null>(paths.status(), null), "status.json");
    expect(snapshot.online).toBe(true);

    const runs = new Map(snapshot.runs.map((r) => [r.runId, r]));
    // alpha still has a live sibling, so the failure is a WARNING, not an error.
    expect(must(runs.get("wf_alpha"), "wf_alpha").state).toBe("warning");
    // beta has nothing left running and one terminal loss.
    expect(must(runs.get("wf_beta"), "wf_beta").state).toBe("completed-with-failures");

    const rendered = renderStatus(snapshot, { color: false, now: clock });
    expect(rendered).toContain("warning");
    expect(rendered).toContain("completed with failures");
    expect(rendered).toContain("LL-0042");
    expect(rendered).not.toMatch(/\berror\b/i);
  });

  it("leaves a healthy in-flight run reading as `running`, with no ledger entries at all", async () => {
    // Acceptance criterion 8: a normal run must look exactly as it did before lifeline existed.
    const gamma = writeRun(tmp.env.projects, "wf_gamma", {
      journal: [
        { type: "started", key: "f".repeat(64), agentId: "g1" },
        { type: "result", key: "f".repeat(64), agentId: "g1", result: "done" },
        { type: "started", key: "0".repeat(64), agentId: "g2" },
      ],
      transcripts: {
        g1: [normalLine("LL-0060 complete.")],
        g2: [normalLine("Starting LL-0061."), normalLine("Editing src/cli/index.ts")],
      },
    });

    const cfg = testConfig();
    const { fn: spawn, calls } = recordingSpawn();
    const clock = Date.now() + 60_000;

    const daemon = start(cfg, {
      now: () => clock,
      rng: () => 0.25,
      watch: false,
      relaunch: { spawn, command: "claude-stub" },
    });
    daemon.markDirty(gamma.runDir);
    await daemon.tick();

    const snapshot = must(readJson<StatusSnapshot | null>(paths.status(), null), "status.json");
    const run = must(
      snapshot.runs.find((r) => r.runId === "wf_gamma"),
      "wf_gamma",
    );
    expect(run.state).toBe("running");
    // v2: healthy agents are surfaced with telemetry (names, durations, context) so the UI
    // can show them; recovery still never fired, so the ledger stays empty.
    expect(run.agents.map((a) => a.state).sort()).toEqual(["done", "retrying"]);
    expect(Object.keys(loadLedger("wf_gamma").entries)).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(renderStatus(snapshot, { color: false, now: clock })).not.toMatch(/\bwarning\b/);
  });

  it("computeRunState: the rollup rules the status surface depends on", () => {
    const view = (state: RunAgentView["state"], live = false): RunAgentView => ({ state, live });

    expect(computeRunState([view("done"), view("done")])).toBe("completed");
    // A healthy in-flight run is `running` — the live placeholder must not read as recovering.
    expect(computeRunState([view("retrying", true)])).toBe("running");
    expect(computeRunState([view("retrying", true), view("retrying", true)])).toBe("running");
    expect(computeRunState([view("done"), view("retrying", true)])).toBe("running");
    // A failure alongside a live sibling is a warning, never an error.
    expect(computeRunState([view("failed-terminal"), view("retrying", true)])).toBe("warning");
    expect(computeRunState([view("retrying"), view("retrying", true)])).toBe("warning");
    // Nothing live left: a terminal failure downgrades the whole run's completion.
    expect(computeRunState([view("failed-terminal"), view("done")])).toBe("completed-with-failures");
    // Still recovering, nothing live.
    expect(computeRunState([view("retrying"), view("done")])).toBe("recovering");
    expect(computeRunState([view("paused-usage-limit")])).toBe("recovering");
    expect(computeRunState([])).toBe("completed");
  });

  it("honours a manual pause intent, and resumes on retry", async () => {
    const alpha = writeAlpha(tmp.env.projects);
    const cfg = testConfig();
    const { fn: spawn, calls } = recordingSpawn();
    let clock = Date.now() + 60_000;

    const daemon = start(cfg, {
      now: () => clock,
      rng: () => 0.25,
      watch: false,
      relaunch: { spawn, command: "claude-stub" },
    });
    daemon.markDirty(alpha.runDir);
    await daemon.tick();

    // The CLI writes intents as files; the daemon drains them on the next tick.
    mkdirSync(paths.intentsDir(), { recursive: true });
    writeFileSync(
      join(paths.intentsDir(), `${clock}-pause.json`),
      JSON.stringify({
        id: "intent-1",
        kind: "pause",
        target: { runId: "wf_alpha", agentId: "a2" },
        createdAt: clock,
      }),
      "utf8",
    );

    clock += 300;
    await daemon.tick();

    const paused = must(getEntry(must(loadLedger("wf_alpha"), "ledger"), KEY.alphaLost), "entry");
    expect(paused.state).toBe("paused-manual");
    expect(paused.nextRetryAt).toBeNull();
    expect(calls).toHaveLength(0); // a paused agent is never relaunched

    // Retry == resume: idempotent, and it re-arms the schedule immediately.
    writeFileSync(
      join(paths.intentsDir(), `${clock}-retry.json`),
      JSON.stringify({
        id: "intent-2",
        kind: "retry",
        target: { runId: "wf_alpha", agentId: "a2" },
        createdAt: clock,
      }),
      "utf8",
    );

    await daemon.tick();

    expect(calls).toHaveLength(1);
    const resumed = must(getEntry(must(loadLedger("wf_alpha"), "ledger"), KEY.alphaLost), "entry");
    expect(resumed.attempts).toBe(1);
  });
});
