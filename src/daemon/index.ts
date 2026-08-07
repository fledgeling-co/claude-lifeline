/**
 * `lifelined` — the journal-watching recovery daemon (Seam B).
 *
 * Watches every live workflow run directory, keeps a persisted retry ledger, and drives
 * class-aware recovery for the agents the runtime lost silently. It also honours control
 * intents written by the CLI and the connectivity events emitted by the gateway, and
 * publishes the status snapshot the CLI and a later UI read.
 *
 * It only ever reads Claude Code's journals and writes under ~/.lifeline.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { exponentialCeiling } from "../shared/backoff.js";
import type { LifelineConfig } from "../shared/config.js";
import { loadConfig } from "../shared/config.js";
import { ensureDir, readJson, writeJsonAtomic } from "../shared/io.js";
import { makeLogger } from "../shared/logger.js";
import { claudeProjectsDir, paths } from "../shared/paths.js";
import type {
  AgentState,
  ConnectivityEvent,
  ControlIntent,
  LedgerEntry,
  RunLedger,
  RunState,
  StatusAgent,
  StatusRun,
  StatusSnapshot,
} from "../shared/types.js";
import {
  dueEntries,
  emptyLedger,
  getEntry,
  isTerminal,
  loadAllLedgers,
  markDone,
  markPaused,
  markResumed,
  newEntry,
  rearmAfterAttempt,
  saveLedger,
  scheduleNext,
  upsertEntry,
} from "./ledger.js";
import type { RunScan } from "./journal.js";
import { scanRunDir } from "./journal.js";
import type { RelaunchDeps, RelaunchOutcome } from "./recovery.js";
import { executeRelaunch, isDue, makeRepoSerializer, planRecovery } from "./recovery.js";

const log = makeLogger("daemon");

/* ------------------------------------------------------------------ *
 * Pure run-state rollup
 * ------------------------------------------------------------------ */

/** One agent as the run-state rollup sees it: its ledger state, plus whether it is still running. */
export interface RunAgentView {
  state: AgentState;
  /** True for an agent that has started, has no result, and has not died. */
  live: boolean;
}

const RECOVERING: ReadonlySet<AgentState> = new Set<AgentState>([
  "retrying",
  "paused-offline",
  "paused-usage-limit",
  "paused-manual",
]);

/**
 * Run-level rollup (feature spec §C, requirement 4): a per-agent error while siblings still
 * run is a WARNING against the workflow, not an error. Only a finished run with a terminal
 * failure is `completed-with-failures`.
 *
 * `recovering` is scoped to agents that are NOT live. A live agent is one that has started and
 * has neither finished nor died, and `statusRunOf` represents it with a placeholder state; if
 * that placeholder were allowed to count as recovering, a perfectly healthy in-flight run would
 * report `warning` and `running` would be unreachable.
 */
export function computeRunState(agents: RunAgentView[]): RunState {
  const live = agents.some((a) => a.live);
  const failed = agents.some((a) => a.state === "failed-terminal");
  const recovering = agents.some((a) => !a.live && RECOVERING.has(a.state));

  if (live && (failed || recovering)) return "warning";
  if (live) return "running";
  if (failed) return "completed-with-failures";
  if (recovering) return "recovering";
  return "completed";
}

/* ------------------------------------------------------------------ *
 * Watch pruning
 * ------------------------------------------------------------------ */

/**
 * chokidar 4 dropped glob support, so the `<project>/<session>/subagents/workflows/wf_...`
 * shape is a prune predicate: return true to ignore (and, for a directory, not descend).
 * Without this the daemon would walk every project's entire session history.
 */
export function makeIgnorePredicate(base: string): (path: string) => boolean {
  return (path: string): boolean => {
    if (path === base) return false;
    const rel = relative(base, path);
    if (rel.startsWith("..")) return true;
    const segs = rel.split(sep).filter((s) => s.length > 0);
    switch (segs.length) {
      case 0:
        return false;
      case 1: // <project>
      case 2: // <session>
        return false;
      case 3:
        return segs[2] !== "subagents";
      case 4:
        return segs[3] !== "workflows";
      case 5:
        return !(segs[4] ?? "").startsWith("wf_");
      case 6: {
        const f = segs[5] ?? "";
        return !(f === "journal.jsonl" || /^agent-.+\.jsonl$/.test(f));
      }
      default:
        return true;
    }
  };
}

/** The wf_ directory a changed file belongs to, or null if the path is not inside one. */
export function runDirOf(base: string, path: string): string | null {
  const rel = relative(base, path);
  if (rel.startsWith("..")) return null;
  const segs = rel.split(sep).filter((s) => s.length > 0);
  if (segs.length < 5) return null;
  if (segs[2] !== "subagents" || segs[3] !== "workflows") return null;
  if (!(segs[4] ?? "").startsWith("wf_")) return null;
  return [base, ...segs.slice(0, 5)].join(sep);
}

/* ------------------------------------------------------------------ *
 * Daemon
 * ------------------------------------------------------------------ */

export interface DaemonDeps {
  now?: (() => number) | undefined;
  rng?: (() => number) | undefined;
  /** Injectable scan so tests drive the daemon off fixtures without a watcher. */
  scan?: ((runDir: string, opts: { now: number; liveWindowMs: number }) => RunScan | null) | undefined;
  relaunch?: RelaunchDeps | undefined;
  /** Skip the chokidar watcher (tests tick manually). */
  watch?: boolean | undefined;
}

export interface DaemonHandle {
  stop: () => Promise<void>;
  /** Run one full cycle immediately — drains dirty runs, intents, connectivity, schedules. */
  tick: () => Promise<void>;
  /** Queue a run directory for rescan. */
  markDirty: (runDir: string) => void;
}

export function startDaemon(
  cfg: LifelineConfig = loadConfig(),
  deps: DaemonDeps = {},
): DaemonHandle {
  const now = deps.now ?? (() => Date.now());
  const rng = deps.rng ?? Math.random;
  const scan = deps.scan ?? scanRunDir;
  const base = claudeProjectsDir();

  ensureDir(paths.home());
  ensureDir(paths.ledgerDir());
  ensureDir(paths.intentsDir());

  // Persisted ledgers are reloaded so retry state survives a daemon restart.
  const ledgers = loadAllLedgers();
  const scans = new Map<string, RunScan>();
  const dirty = new Set<string>();
  const serializer = makeRepoSerializer();

  let online = true;
  let lastConnectivityAt = 0;
  let stopped = false;
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;

  log.info(`watching ${base}`, { ledgers: ledgers.size, tickMs: cfg.daemonTickMs });

  function markDirty(runDir: string): void {
    dirty.add(runDir);
  }

  /* ---------------- scan → ledger ---------------- */

  function ingest(runDir: string): void {
    const t = now();
    const result = scan(runDir, { now: t, liveWindowMs: cfg.liveWindowMs });
    if (!result) return;
    scans.set(result.runId, result);

    let ledger =
      ledgers.get(result.runId) ??
      emptyLedger({
        runId: result.runId,
        project: result.project,
        sessionId: result.sessionId,
        scriptPath: result.scriptPath,
        args: result.args,
        now: t,
      });
    // A run's script path only becomes known once the snapshot lands.
    if (!ledger.scriptPath && result.scriptPath) ledger = { ...ledger, scriptPath: result.scriptPath };

    for (const finding of result.lost) {
      const existing = getEntry(ledger, finding.key);
      // Idempotence, and restart-safety: an entry touched at or after the transcript's last
      // write has already accounted for that failure. `updatedAt` persists, so a daemon
      // restart re-reads the same stale transcript without inflating the attempt count.
      if (existing && existing.updatedAt >= finding.mtimeMs) continue;
      if (existing && isTerminal(existing.state)) continue;
      // A manually paused agent stays paused; a new failure must not silently re-arm it.
      if (existing && existing.state === "paused-manual") continue;

      const seed =
        existing ??
        newEntry({
          key: finding.key,
          runId: result.runId,
          item: finding.item,
          agentId: finding.agentId,
          now: t,
        });
      const updated = scheduleNext(seed, finding.classification, cfg.recovery, t, {
        rng,
        lastError: finding.errorText,
      });
      const parked = online ? updated : markPaused(updated, "paused-offline", t);
      ledger = upsertEntry(ledger, parked);
      log.info(
        `lost agent ${finding.agentId} (${finding.item ?? "?"}) ${finding.classification.class} -> ${parked.state}`,
        { run: result.runId, attempt: parked.attempts, nextRetryAt: parked.nextRetryAt },
      );
    }

    // Recovery is over only on EVIDENCE: a journaled result for that key. Inferring it from
    // "no longer in the lost list" would call an agent done the moment its relaunch started
    // writing a fresh transcript, which is precisely when it is still working.
    const resultKeys = new Set(result.resultKeys);
    for (const entry of Object.values(ledger.entries)) {
      if (resultKeys.has(entry.key) && entry.state !== "done") {
        ledger = upsertEntry(ledger, markDone(entry, t));
        log.info(`recovered ${entry.agentId ?? entry.key.slice(0, 12)}`, { run: result.runId });
      }
    }

    ledgers.set(result.runId, ledger);
    saveLedger(ledger);
  }

  /* ---------------- intents ---------------- */

  function applyIntents(): void {
    const t = now();
    let files: string[];
    try {
      files = readdirSync(paths.intentsDir()).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      const full = `${paths.intentsDir()}${sep}${file}`;
      const intent = readJson<ControlIntent | null>(full, null);
      // Consume the intent either way: a malformed file must not be replayed forever.
      try {
        rmSync(full, { force: true });
      } catch {
        /* best effort */
      }
      if (!intent || !intent.target || typeof intent.target.runId !== "string") continue;
      applyIntent(intent, t);
    }
  }

  function applyIntent(intent: ControlIntent, t: number): void {
    const ledger = ledgers.get(intent.target.runId);
    if (!ledger) {
      log.warn(`intent ${intent.kind} for unknown run ${intent.target.runId}`);
      return;
    }
    const wantAgent = intent.target.agentId ?? null;
    let next = ledger;
    for (const entry of Object.values(ledger.entries)) {
      if (wantAgent && entry.agentId !== wantAgent) continue;
      if (intent.kind === "pause") {
        if (entry.state === "done") continue;
        next = upsertEntry(next, markPaused(entry, "paused-manual", t));
      } else {
        // retry == resume: idempotent, and a no-op on an agent that already finished.
        if (entry.state === "done") continue;
        next = upsertEntry(next, markResumed(entry, t, t));
      }
    }
    ledgers.set(next.runId, next);
    saveLedger(next);
    log.info(`intent ${intent.kind} applied`, { run: intent.target.runId, agent: wantAgent });
  }

  /* ---------------- connectivity ---------------- */

  function applyConnectivity(): void {
    const event = readJson<ConnectivityEvent | null>(paths.connectivity(), null);
    if (!event || typeof event.online !== "boolean") return;
    if (event.at === lastConnectivityAt && event.online === online) return;
    lastConnectivityAt = event.at ?? 0;
    if (event.online === online) return;

    const t = now();
    online = event.online;
    log.info(`connectivity ${online ? "up" : "down"}`, { reason: event.reason });

    for (const [runId, ledger] of ledgers) {
      let next = ledger;
      for (const entry of Object.values(ledger.entries)) {
        if (!online && (entry.state === "retrying" || entry.state === "paused-usage-limit")) {
          next = upsertEntry(next, markPaused(entry, "paused-offline", t));
        } else if (online && entry.state === "paused-offline") {
          // Per-entry jitter so a reconnect does not fire every parked agent at once.
          const window = exponentialCeiling(cfg.recovery, entry.attempts);
          next = upsertEntry(next, markResumed(entry, t + Math.floor(rng() * window), t));
        }
      }
      if (next !== ledger) {
        ledgers.set(runId, next);
        saveLedger(next);
      }
    }
  }

  /* ---------------- scheduling ---------------- */

  async function driveRecoveries(): Promise<void> {
    if (!online) return;
    const t = now();
    for (const [runId, ledger] of ledgers) {
      const run = scans.get(runId);
      if (!run) continue;
      for (const entry of dueEntries(ledger, t)) {
        const finding = { key: entry.key, agentId: entry.agentId, item: entry.item };
        const plan = planRecovery({ run, finding, entry, now: t });
        if (!isDue(plan, t)) continue;
        const repoKey = plan.cwd ?? plan.project;
        await serializer.run(repoKey, () => {
          const outcome: RelaunchOutcome = executeRelaunch(plan, deps.relaunch ?? {});
          if (outcome.ok) {
            log.info(`${plan.kind} ${plan.item ?? plan.agentId ?? plan.key.slice(0, 12)}`, {
              run: runId,
              attempt: plan.attempt,
              pid: outcome.pid,
            });
          } else {
            log.error(`relaunch failed: ${outcome.error}`, { run: runId, argv: outcome.argv });
          }
        });
        // Book the next probe rather than clearing the schedule: a usage-limit park must keep
        // probing so it picks up whichever proxy account frees first. This does not count a
        // new failure — only a newer transcript does.
        const rearmed = rearmAfterAttempt(entry, cfg.recovery, t, { rng });
        const next = upsertEntry(ledgers.get(runId) ?? ledger, rearmed);
        ledgers.set(runId, next);
        saveLedger(next);
      }
    }
  }

  /* ---------------- status ---------------- */

  function statusRunOf(ledger: RunLedger): StatusRun {
    const run = scans.get(ledger.runId);
    const entries = Object.values(ledger.entries);
    const views: RunAgentView[] = entries.map((e) => ({ state: e.state, live: false }));
    for (let i = 0; i < (run?.liveAgents ?? 0); i += 1) views.push({ state: "retrying", live: true });

    const agents: StatusAgent[] = entries.map((e) => ({
      agentId: e.agentId,
      item: e.item,
      state: e.state,
      attempts: e.attempts,
      maxAttempts: cfg.recovery.maxAttempts,
      nextRetryAt: e.nextRetryAt,
      lastClass: e.lastClass,
    }));

    return {
      runId: ledger.runId,
      project: ledger.project,
      // A live sibling is what turns a per-agent failure into a run-level warning.
      state: computeRunState(views),
      agents,
    };
  }

  function writeStatus(): void {
    const snapshot: StatusSnapshot = {
      updatedAt: now(),
      online,
      runs: [...ledgers.values()].map(statusRunOf),
    };
    try {
      writeJsonAtomic(paths.status(), snapshot);
    } catch (err) {
      log.error("failed to write status", String(err));
    }
  }

  /* ---------------- the cycle ---------------- */

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      for (const runDir of [...dirty]) {
        dirty.delete(runDir);
        try {
          ingest(runDir);
        } catch (err) {
          log.error(`scan failed for ${runDir}`, String(err));
        }
      }
      applyIntents();
      applyConnectivity();
      await driveRecoveries();
      writeStatus();
    } catch (err) {
      log.error("tick failed", String(err));
    }
  }

  if (deps.watch !== false) {
    watcher = watch(base, {
      ignored: makeIgnorePredicate(base),
      depth: 6,
      ignoreInitial: true, // live runs arrive as events; restart continuity comes from the ledgers
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    const onPath = (p: string): void => {
      const runDir = runDirOf(base, p);
      if (runDir) markDirty(runDir);
    };
    watcher.on("add", onPath);
    watcher.on("change", onPath);
    watcher.on("unlink", onPath);
    watcher.on("error", (err: unknown) => log.error("watcher error", String(err)));

    // A ledger reloaded from disk names a run whose directory may still be producing events;
    // re-ingest it once so a restart resumes with current facts rather than stale ones.
    for (const ledger of ledgers.values()) {
      const dir = findRunDir(base, ledger);
      if (dir) markDirty(dir);
    }
  }

  timer = setInterval(() => void tick(), cfg.daemonTickMs);
  timer.unref();

  return {
    tick,
    markDirty,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (watcher) await watcher.close();
      watcher = null;
    },
  };
}

/** Rebuild a run directory path from a persisted ledger, if it still exists. */
function findRunDir(base: string, ledger: RunLedger): string | null {
  const dir = [base, ledger.project, ledger.sessionId, "subagents", "workflows", ledger.runId].join(sep);
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Entrypoint
 * ------------------------------------------------------------------ */

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const handle = startDaemon(loadConfig());
  const shutdown = (): void => {
    void handle.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
