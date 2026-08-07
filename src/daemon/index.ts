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
import { basename, join, relative, sep } from "node:path";
import type { Classification } from "../shared/classifier.js";
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
  "stalled",
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

/**
 * Discover workflow run directories whose transcripts were written within `windowMs`,
 * WITHOUT holding a filesystem watch handle (a recursive chokidar watch opens a handle per
 * directory and EMFILEs against a 12k-dir tree — the fragility lifeline exists to remove).
 *
 * Keyed off FILE mtimes, not directory mtimes. A directory's mtime only changes when a
 * child is added or removed, NOT when a file inside it is appended to — so a live workflow
 * that is appending to an existing journal.jsonl never bumps any ancestor directory mtime,
 * and a dir-mtime scan misses it entirely (it would only ever catch the fan-out moment when
 * a new agent file appears). We therefore stat the run's journal.jsonl + newest agent file.
 *
 * `projectPrefilterMs` is a cheap, generous pre-filter: a project directory's mtime bumps
 * whenever a session is added to it, so an actively-used project has a recent mtime. This
 * skips the thousands of ancient temp/scratch project dirs without statting their files. It
 * is deliberately wide (default a week) so a workflow run in a resumed older session is
 * still found; set it to 0 to scan every project.
 */
export function discoverActiveRunDirs(
  base: string,
  windowMs: number,
  now: number,
  projectPrefilterMs = 7 * 24 * 60 * 60 * 1000,
): string[] {
  const cutoff = now - windowMs;
  const out: string[] = [];

  const mtime = (p: string): number => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  const kids = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };
  /** Newest mtime among a run dir's journal + agent transcript files. */
  const newestTranscriptMtime = (runDir: string): number => {
    let newest = mtime(join(runDir, "journal.jsonl"));
    try {
      for (const f of readdirSync(runDir)) {
        if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
          const m = mtime(join(runDir, f));
          if (m > newest) newest = m;
        }
      }
    } catch {
      /* run dir vanished */
    }
    return newest;
  };

  const projectCutoff = projectPrefilterMs > 0 ? now - projectPrefilterMs : 0;
  for (const project of kids(base)) {
    if (projectCutoff > 0 && mtime(project) < projectCutoff) continue; // ancient temp/scratch
    for (const session of kids(project)) {
      const workflows = join(session, "subagents", "workflows");
      for (const runDir of kids(workflows)) {
        if (basename(runDir).startsWith("wf_") && newestTranscriptMtime(runDir) >= cutoff) {
          out.push(runDir);
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Daemon
 * ------------------------------------------------------------------ */

export interface DaemonDeps {
  now?: (() => number) | undefined;
  rng?: (() => number) | undefined;
  /** Injectable scan so tests drive the daemon off fixtures without a watcher. */
  scan?: ((runDir: string, opts: { now: number; liveWindowMs: number; stallWindowMs?: number; contextLimitTokens?: number }) => RunScan | null) | undefined;
  relaunch?: RelaunchDeps | undefined;
  /** Skip discovery/live scanning (tests tick manually via markDirty). */
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
  let lastDiscoveryAt = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  log.info(`watching ${base}`, { ledgers: ledgers.size, tickMs: cfg.daemonTickMs });

  function markDirty(runDir: string): void {
    dirty.add(runDir);
  }

  /* ---------------- scan → ledger ---------------- */

  function ingest(runDir: string): void {
    const t = now();
    const result = scan(runDir, {
      now: t,
      liveWindowMs: cfg.liveWindowMs,
      stallWindowMs: cfg.stallWindowMs,
      contextLimitTokens: cfg.contextLimitTokens,
    });
    if (!result) return;
    // An abandoned run (no live agent, idle past its grace, not waiting out a reset) is dropped
    // at its source: forget it AND delete its persisted ledger, so a re-discovery this tick or a
    // daemon restart can't resurrect it. Without the file delete, every restart reloaded the
    // stale ledger from disk and the ghost fleet rows came back.
    if (runIsAbandoned(result, ledgers.get(result.runId), t)) {
      forgetRun(result.runId);
      return;
    }
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

    // Stalled agents: alive, but silent past the stall window. Treated like a retryable loss
    // (a synthesized STALL classification) so the same ledger + relaunch path recovers it.
    for (const s of result.stalled) {
      const existing = getEntry(ledger, s.key);
      if (existing && existing.updatedAt >= s.mtimeMs) continue;
      if (existing && (isTerminal(existing.state) || existing.state === "paused-manual")) continue;
      const seed =
        existing ??
        newEntry({ key: s.key, runId: result.runId, item: s.item, agentId: s.agentId, now: t });
      const stallClass: Classification = {
        class: "STALL",
        retryable: true,
        park: false,
        retryAfterMs: null,
        reason: `no output or context change for ${Math.round(s.quietForMs / 60000)}m`,
      };
      const updated = scheduleNext(seed, stallClass, cfg.recovery, t, {
        rng,
        lastError: `stalled ${Math.round(s.quietForMs / 60000)}m`,
      });
      const parked = online ? updated : markPaused(updated, "paused-offline", t);
      ledger = upsertEntry(ledger, parked);
      log.info(`stalled agent ${s.agentId} (${s.item ?? "?"}) -> ${parked.state}`, {
        run: result.runId,
        quietForMs: s.quietForMs,
      });
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
    const t = now();
    const ledgerEntries = ledger.entries;
    const teleByAgent = new Map<string, (typeof run extends undefined ? never : NonNullable<typeof run>)["agents"][number]>();
    for (const a of run?.agents ?? []) if (a.agentId) teleByAgent.set(a.agentId, a);

    // Build one StatusAgent per KNOWN agent: every transcript the scan saw, plus any ledger
    // entry whose agent has no live transcript (e.g. relocated). Ledger state wins over the
    // scan's kind (the ledger knows about pauses, retries and terminal failures the scan can't).
    const seen = new Set<string>();
    const agents: StatusAgent[] = [];
    const views: RunAgentView[] = [];

    for (const a of run?.agents ?? []) {
      const entry = a.agentId ? findEntryByAgent(ledgerEntries, a.agentId) : null;
      const state: AgentState = entry ? entry.state : scanKindToState(a.kind);
      const live = a.kind === "live" && (!entry || entry.state === "done" || entry.state === "retrying");
      views.push({ state, live });
      agents.push({
        agentId: a.agentId,
        item: a.item ?? entry?.item ?? null,
        state,
        attempts: entry?.attempts ?? 0,
        maxAttempts: cfg.recovery.maxAttempts,
        nextRetryAt: entry?.nextRetryAt ?? null,
        lastClass: entry?.lastClass ?? null,
        durationMs: a.durationMs,
        contextFrac: a.contextFrac,
        contextTokens: a.contextTokens,
        stalledForMs: a.kind === "stalled" ? a.quietForMs : null,
        tail: a.tail,
      });
      if (a.agentId) seen.add(a.agentId);
    }
    // Ledger entries with no matching transcript this scan (relocated/older runs).
    for (const e of Object.values(ledgerEntries)) {
      if (e.agentId && seen.has(e.agentId)) continue;
      views.push({ state: e.state, live: false });
      agents.push({
        agentId: e.agentId,
        item: e.item,
        state: e.state,
        attempts: e.attempts,
        maxAttempts: cfg.recovery.maxAttempts,
        nextRetryAt: e.nextRetryAt,
        lastClass: e.lastClass,
      });
    }

    const contextFrac = agents.reduce<number | null>(
      (m, a) => (a.contextFrac == null ? m : m == null ? a.contextFrac : Math.max(m, a.contextFrac)),
      null,
    );

    // Compact row counts, from the scan's unambiguous kinds. "running" is LIVE agents only —
    // a stalled agent has stopped producing output, so counting it as running was the bug that
    // showed an abandoned fleet as "9 running". "pending" is planned-minus-started when known.
    const scanAgents = run?.agents ?? [];
    const runningCount = scanAgents.filter((a) => a.kind === "live").length;
    const doneCount = scanAgents.filter((a) => a.kind === "done").length;
    const pendingCount =
      run?.plannedCount != null ? Math.max(0, run.plannedCount - scanAgents.length) : null;

    return {
      runId: ledger.runId,
      project: ledger.project,
      workflowName: run?.workflowName ?? null,
      workspace: run?.workspace ?? null,
      state: computeRunState(views),
      agents,
      runningCount,
      pendingCount,
      doneCount,
      durationMs: run?.startedAtMs != null ? t - run.startedAtMs : null,
      contextFrac,
      note: runNote(run),
      cwd: run?.cwd ?? null,
      callerTail: run?.callerTail ?? [],
      ...terminalFor(run?.cwd ?? null),
    };
  }

  /** Match a run to the wrapper's per-tty terminal record by cwd, for the reveal action. */
  function terminalFor(cwd: string | null): { tty?: string | null; term?: string | null } {
    if (!cwd) return {};
    const dir = join(paths.home(), "terminals");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return {};
    }
    for (const f of files) {
      const rec = readJson<{ cwd?: string; tty?: string; term?: string } | null>(join(dir, f), null);
      if (rec && rec.cwd === cwd) return { tty: rec.tty ?? null, term: rec.term ?? null };
    }
    return {};
  }

  /** A ledger entry for an agentId, or null. */
  function findEntryByAgent(entries: RunLedger["entries"], agentId: string) {
    for (const e of Object.values(entries)) if (e.agentId === agentId) return e;
    return null;
  }

  /** The scan's view of an agent with no ledger entry (it never needed recovery). */
  function scanKindToState(kind: RunScan["agents"][number]["kind"]): AgentState {
    switch (kind) {
      case "done":
        return "done";
      case "lost":
        return "failed-terminal";
      case "stalled":
        return "stalled";
      case "live":
        return "running"; // a live, healthy agent — working, not recovering
    }
  }

  /** One-line "what is this run doing now": the most recently active agent's latest line. */
  function runNote(run: RunScan | undefined): string | null {
    if (!run || run.agents.length === 0) return null;
    const working = run.agents.filter((a) => a.kind === "live").length;
    let newest: RunScan["agents"][number] | null = null;
    for (const a of run.agents) {
      if (a.lastTsMs == null) continue;
      if (!newest || (newest.lastTsMs ?? 0) < a.lastTsMs) newest = a;
    }
    const latest = newest?.tail.at(-1);
    if (latest) return latest;
    return working > 0 ? `${working} agent${working === 1 ? "" : "s"} working` : null;
  }

  /** Newest transcript activity for a run, for sorting/capping the list. */
  function lastActivityOf(runId: string): number {
    const scanResult = scans.get(runId);
    if (!scanResult) return 0;
    return Math.max(scanResult.startedAtMs ?? 0, ...scanResult.agents.map((a) => a.lastTsMs ?? 0));
  }

  /** A run whose work is over — completed cleanly or with a terminal failure. */
  function isDoneState(s: RunState): boolean {
    return s === "completed" || s === "completed-with-failures";
  }

  function writeStatus(): void {
    // Active work leads the list, newest-active first. A run that has finished drops out of
    // the active view and, if it ended within the last hour, trails at the bottom (greyed in
    // the UI) so a just-finished run doesn't vanish mid-glance; older finished runs are gone.
    const t = now();
    const all = [...ledgers.values()].map((l) => ({ run: statusRunOf(l), at: lastActivityOf(l.runId) }));
    const active = all.filter((r) => !isDoneState(r.run.state)).sort((a, b) => b.at - a.at);
    // Keep a finished run at the bottom unless we can PROVE it ended over an hour ago; when its
    // activity time is unknown (at === 0) we keep it rather than silently hide a just-done run.
    const doneRecent = all
      .filter((r) => isDoneState(r.run.state) && !(r.at > 0 && t - r.at > cfg.completedRetentionMs))
      .sort((a, b) => b.at - a.at);
    const runs = [...active, ...doneRecent].slice(0, cfg.maxRunsShown).map((r) => r.run);
    const snapshot: StatusSnapshot = {
      updatedAt: now(),
      online,
      runs,
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
      // Discovery: find run dirs whose transcripts changed within the window and mark them
      // dirty. Keyed off file mtimes (a live run appends to existing files and never bumps
      // any dir mtime), run on its own cadence because the walk is heavier than a tick. No
      // persistent fs handles, so it cannot EMFILE regardless of tree size or fd limit.
      if (deps.watch !== false) {
        const t = now();
        if (t - lastDiscoveryAt >= cfg.discoverIntervalMs) {
          lastDiscoveryAt = t;
          for (const runDir of discoverActiveRunDirs(base, cfg.discoverWindowMs, t)) markDirty(runDir);
        }
      }
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
      dropStaleRuns();
      writeStatus();
    } catch (err) {
      log.error("tick failed", String(err));
    }
  }

  /**
   * Drop a run from the live view once it's finished AND idle past the retention window, so
   * the status window shows current work rather than growing without bound. A run with any
   * non-terminal ledger entry (still recovering) is always kept.
   */
  /** Forget a run everywhere it persists: the in-memory maps AND its on-disk ledger, so it
   *  cannot be reloaded on restart or re-ingested this tick. */
  function forgetRun(runId: string): void {
    scans.delete(runId);
    ledgers.delete(runId);
    try {
      rmSync(paths.ledgerFile(runId), { force: true });
    } catch {
      /* best effort */
    }
  }

  /**
   * Is a run abandoned — safe to forget? A run genuinely waiting out an external reset it will
   * resume from (a usage-limit / offline pause with a retry scheduled inside the retention
   * window — the multi-account-proxy case) is NEVER abandoned; its ledger must survive so
   * recovery can fire. Otherwise abandonment is idle time past a grace that depends on why it is
   * quiet: a live agent still writing → the full retention window; all agents finished → the
   * completed-retention window (the greyed "recently done" grace); no live agent and not done →
   * stuck (stalled or paused mid-run), a short grace so a fleet that stopped producing output
   * ~20 min ago stops showing as an active row.
   */
  function runIsAbandoned(scanResult: RunScan | undefined, ledger: RunLedger | undefined, t: number): boolean {
    const entries = ledger ? Object.values(ledger.entries) : [];
    const waitingForReset = entries.some(
      (e) =>
        (e.state === "paused-usage-limit" || e.state === "paused-offline") &&
        e.nextRetryAt != null &&
        e.nextRetryAt > t &&
        e.nextRetryAt - t <= cfg.retentionMs,
    );
    if (waitingForReset) return false;
    const agents = scanResult?.agents ?? [];
    if (agents.some((a) => a.kind === "live")) return false; // still working
    const lastActivity = scanResult
      ? Math.max(scanResult.startedAtMs ?? 0, ...agents.map((a) => a.lastTsMs ?? 0))
      : (ledger?.updatedAt ?? 0);
    const allDone = agents.length > 0 && agents.every((a) => a.kind === "done");
    const idleLimit = allDone ? cfg.completedRetentionMs : 2 * cfg.stallWindowMs;
    return lastActivity > 0 && t - lastActivity > idleLimit;
  }

  function dropStaleRuns(): void {
    const t = now();
    // Iterate the ledgers — exactly the set writeStatus shows — so a run reloaded from a
    // persisted ledger whose dir sits outside the discovery window (never re-scanned) is still
    // reachable here.
    for (const [runId, ledger] of ledgers) {
      if (runIsAbandoned(scans.get(runId), ledger, t)) forgetRun(runId);
    }
  }

  if (deps.watch !== false) {
    // A ledger reloaded from disk names a run whose directory may still be producing
    // output; re-ingest it once so a restart resumes with current facts. Live discovery
    // (in tick) is what keeps up thereafter — see discoverActiveRunDirs on why there is
    // no recursive watcher.
    for (const ledger of ledgers.values()) {
      const dir = findRunDir(base, ledger);
      if (dir) markDirty(dir);
    }
    void tick(); // first discovery pass immediately, don't wait a full interval
  }

  timer = setInterval(() => void tick(), cfg.daemonTickMs);
  // The interval is the daemon's ONLY long-lived handle now that discovery is mtime-polling
  // rather than a persistent chokidar watch — so it MUST keep the event loop alive in
  // production, or the process drains and exits (which had it silently dying every ~10s and
  // limping along on launchd restarts). Only unref under `watch:false` (tests), where the
  // caller drives tick() by hand and always stops the daemon in teardown.
  if (deps.watch === false) timer.unref();

  return {
    tick,
    markDirty,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
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
