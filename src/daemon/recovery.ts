/**
 * Seam B's write side: decide what to do about a lost agent, and (separately) do it.
 *
 * `planRecovery` is pure — it turns a finding plus its ledger entry into a RecoveryPlan and
 * never spawns anything. Execution lives behind `executeRelaunch(plan, deps)` with an
 * injectable spawn, so the scheduling logic can be tested without a real `claude` process.
 */

import { execFileSync } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry } from "../shared/types.js";
import type { RunScan } from "./journal.js";

export type RecoveryKind = "relaunch" | "scheduled-retry" | "none";

export interface RecoveryTarget {
  runId: string;
  sessionId: string;
  project: string;
  agentId: string | null;
  key: string;
  item: string | null;
  scriptPath: string | null;
  cwd: string | null;
  /** Always the run's own id: a resume replays this run's prompt-chain prefix. */
  resumeFromRunId: string;
  /** 1-based attempt this plan represents. */
  attempt: number;
}

export interface ActiveRecoveryPlan extends RecoveryTarget {
  kind: "relaunch" | "scheduled-retry";
  /** Epoch ms the plan becomes due. */
  whenAt: number;
}

export interface NoRecoveryPlan {
  kind: "none";
  runId: string;
  key: string;
  reason: string;
}

export type RecoveryPlan = ActiveRecoveryPlan | NoRecoveryPlan;

/**
 * The agent a plan is about. A fresh `LostAgent` satisfies this, and so does a persisted
 * ledger entry — a restart plans from the ledger before the next rescan lands.
 */
export interface RecoveryFinding {
  key: string;
  agentId: string | null;
  item: string | null;
}

export interface PlanInput {
  /** The run the agent belongs to; supplies scriptPath / session / cwd. */
  run: Pick<RunScan, "runId" | "sessionId" | "project" | "scriptPath" | "cwd">;
  finding: RecoveryFinding;
  entry: LedgerEntry;
  now: number;
}

/**
 * Decide the recovery for one lost agent.
 *
 * `relaunch` is a hot recovery (RATE_LIMIT / OVERLOADED / CONN that outlived the gateway);
 * `scheduled-retry` is the usage-limit park, which is still driven by the ledger's jittered
 * schedule rather than a hard sleep to one parsed reset — the user's proxy rotates accounts
 * with different resets, so we want whichever binding frees first.
 */
export function planRecovery(input: PlanInput): RecoveryPlan {
  const { entry, run, finding } = input;
  const none = (reason: string): NoRecoveryPlan => ({
    kind: "none",
    runId: run.runId,
    key: entry.key,
    reason,
  });

  switch (entry.state) {
    case "done":
      return none("agent already produced a result");
    case "failed-terminal":
      return none(`terminal (${entry.lastClass ?? "unknown"}) — never blind-retried`);
    case "paused-manual":
      return none("paused by a manual intent");
    case "paused-offline":
      return none("paused while connectivity is down");
    case "retrying":
    case "paused-usage-limit":
      break;
  }

  if (entry.nextRetryAt === null) return none("no retry scheduled");

  const target: RecoveryTarget = {
    runId: run.runId,
    sessionId: run.sessionId,
    project: run.project,
    agentId: finding.agentId ?? entry.agentId,
    key: entry.key,
    item: finding.item ?? entry.item,
    scriptPath: run.scriptPath,
    cwd: run.cwd,
    resumeFromRunId: run.runId,
    attempt: entry.attempts,
  };

  return {
    ...target,
    kind: entry.state === "paused-usage-limit" ? "scheduled-retry" : "relaunch",
    whenAt: entry.nextRetryAt,
  };
}

export function isDue(plan: RecoveryPlan, now: number): plan is ActiveRecoveryPlan {
  return plan.kind !== "none" && plan.whenAt <= now;
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export interface SpawnResult {
  pid: number | null;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string | undefined },
) => SpawnResult;

export interface RelaunchDeps {
  /** Injectable so tests assert the argv without starting a process. */
  spawn?: SpawnFn | undefined;
  /** Command to run; the installed launcher wrapper, not Anthropic's binary directly. */
  command?: string | undefined;
}

export interface RelaunchOutcome {
  ok: boolean;
  argv: string[];
  command: string;
  pid: number | null;
  error?: string;
}

/**
 * Build the resume invocation. Recovery re-enters the SESSION that owns the run and asks the
 * workflow to be re-dispatched with `resumeFromRunId`, which replays the journal's cached
 * prefix and re-runs only the agents that have no result. Kept pure and exported so the
 * argv is asserted in tests rather than observed through a process.
 */
export function buildRelaunchArgv(plan: ActiveRecoveryPlan): string[] {
  const lines = [
    `Resume workflow run ${plan.resumeFromRunId}: re-dispatch it with resumeFromRunId="${plan.resumeFromRunId}"`,
    plan.scriptPath ? `using the persisted script at ${plan.scriptPath}.` : "using its persisted script.",
    plan.item ? `The lost item is ${plan.item}.` : "",
    "Cached results replay from the journal; only agents without a result are re-run. Do not start new work.",
  ].filter((l) => l.length > 0);
  return ["--resume", plan.sessionId, "-p", lines.join(" ")];
}

const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid ?? null };
};

/** Execute a due plan. Never throws — a failed spawn is reported, not propagated. */
export function executeRelaunch(plan: ActiveRecoveryPlan, deps: RelaunchDeps = {}): RelaunchOutcome {
  const command = deps.command ?? "claude";
  const spawn = deps.spawn ?? defaultSpawn;
  const argv = buildRelaunchArgv(plan);
  try {
    const { pid } = spawn(command, argv, { cwd: plan.cwd ?? undefined });
    return { ok: true, argv, command, pid };
  } catch (err) {
    return { ok: false, argv, command, pid: null, error: String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * Git reconciliation
 * ------------------------------------------------------------------ */

export interface GitResult {
  status: number;
  stdout: string;
}

export type GitRunner = (args: string[], cwd: string) => GitResult;

export const defaultGit: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { status: 0, stdout };
  } catch (err) {
    const status = isRecord(err) && typeof err["status"] === "number" ? err["status"] : 1;
    return { status, stdout: "" };
  }
};

/**
 * Before trusting a cached `MERGED` claim, prove it by ANCESTRY rather than by commit-message
 * grep (carried over from workflow-resume: a `--grep` match is not evidence a branch landed).
 *
 * Returns true when the work is genuinely merged, or when there is nothing to check — no repo
 * and no branch means there is no merge claim to disprove, so recovery proceeds.
 */
export function reconcile(
  git: GitRunner | null,
  repoPath: string | null,
  branch: string | null,
): boolean {
  if (!repoPath || !branch) return true;
  if (!existsSync(join(repoPath, ".git"))) return true;
  const run = git ?? defaultGit;
  const exists = run(["rev-parse", "--verify", "--quiet", branch], repoPath);
  if (exists.status !== 0) return false; // claimed merged, but the branch is unknown here
  return run(["merge-base", "--is-ancestor", branch, "HEAD"], repoPath).status === 0;
}

/**
 * Serialise recoveries that touch the same repo: two `claude --resume` processes in one
 * worktree would race on the index. Keyed chaining, one queue per repo path.
 */
export function makeRepoSerializer(): {
  run: <T>(repoKey: string, fn: () => Promise<T> | T) => Promise<T>;
  pending: () => number;
} {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(repoKey: string, fn: () => Promise<T> | T): Promise<T> {
      const prior = tails.get(repoKey) ?? Promise.resolve();
      // `then(fn, fn)` so one failed recovery does not wedge the rest of that repo's queue.
      const next = prior.then(fn, fn);
      tails.set(
        repoKey,
        next.catch(() => undefined),
      );
      return next;
    },
    pending: () => tails.size,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
