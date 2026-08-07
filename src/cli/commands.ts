/**
 * Command implementations for the `lifeline` CLI (Seam C).
 *
 * Every command takes an injectable `CommandDeps` and returns a plain result object;
 * `index.ts` owns all printing and exit codes. That split keeps the command logic
 * testable without a filesystem, a gateway, or a running daemon.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { gatewayUrl, loadConfig } from "../shared/config.js";
import type { LifelineConfig } from "../shared/config.js";
import { ensureDir, readJson, writeJsonAtomic } from "../shared/io.js";
import { paths } from "../shared/paths.js";
import type { ControlIntent, StatusSnapshot } from "../shared/types.js";

/** Pidfile the daemon writes. Inside ~/.lifeline, alongside the other runtime state. */
export const DAEMON_PIDFILE = (): string => join(paths.home(), "lifelined.pid");

/**
 * Whatever the fingerprint watcher writes on contract drift. Deliberately all-optional
 * and structural so the CLI keeps reading it if that module's shape grows.
 */
export interface IncompatFlag {
  version?: string;
  detectedAt?: number;
  reason?: string;
  probes?: string[];
}

export interface GatewayProbe {
  reachable: boolean;
  status: number | null;
  url: string;
  error: string | null;
}

export interface DaemonCheck {
  running: boolean;
  pid: number | null;
  /** Age of status.json in ms, or null when it does not exist. */
  statusAgeMs: number | null;
  detail: string;
}

export interface CommandDeps {
  config(): LifelineConfig;
  now(): number;
  env: NodeJS.ProcessEnv;
  readSnapshot(): StatusSnapshot | null;
  /** Persist a control intent for the daemon; returns the file written. */
  writeIntent(intent: ControlIntent): string;
  probeGateway(url: string): Promise<GatewayProbe>;
  checkDaemon(cfg: LifelineConfig, now: number): DaemonCheck;
  readIncompat(): IncompatFlag | null;
  newId(): string;
}

/* ------------------------------------------------------------- default deps */

function defaultReadSnapshot(): StatusSnapshot | null {
  return readJson<StatusSnapshot | null>(paths.status(), null);
}

function defaultWriteIntent(intent: ControlIntent): string {
  ensureDir(paths.intentsDir());
  // Timestamp-first so the daemon can drain the directory in creation order.
  const file = join(paths.intentsDir(), `${intent.createdAt}-${intent.id}.json`);
  writeJsonAtomic(file, intent);
  return file;
}

async function defaultProbeGateway(url: string): Promise<GatewayProbe> {
  try {
    // Any HTTP answer proves the listener is up; a 404 from the gateway root is fine.
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2000) });
    return { reachable: true, status: res.status, url, error: null };
  } catch (err) {
    return { reachable: false, status: null, url, error: errorMessage(err) };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultCheckDaemon(cfg: LifelineConfig, now: number): DaemonCheck {
  let pid: number | null = null;
  try {
    const raw = readFileSync(DAEMON_PIDFILE(), "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    // No pidfile — fall through to the status.json heartbeat.
  }

  let statusAgeMs: number | null = null;
  try {
    statusAgeMs = Math.max(0, now - statSync(paths.status()).mtimeMs);
  } catch {
    statusAgeMs = null;
  }

  if (pid != null && processAlive(pid)) {
    return { running: true, pid, statusAgeMs, detail: `lifelined running (pid ${pid})` };
  }

  // No usable pidfile: treat a freshly-written snapshot as the heartbeat. A few ticks of
  // slack absorbs a daemon that is mid-tick when doctor runs.
  const freshWindowMs = Math.max(cfg.daemonTickMs * 4, 30_000);
  if (statusAgeMs != null && statusAgeMs <= freshWindowMs) {
    return {
      running: true,
      pid,
      statusAgeMs,
      detail: `status.json written ${Math.round(statusAgeMs / 1000)}s ago`,
    };
  }

  const detail =
    statusAgeMs == null
      ? "no pidfile and no status.json"
      : `no live pid; status.json is ${Math.round(statusAgeMs / 1000)}s stale`;
  return { running: false, pid, statusAgeMs, detail };
}

function defaultReadIncompat(): IncompatFlag | null {
  return readJson<IncompatFlag | null>(paths.incompatFlag(), null);
}

export function defaultDeps(): CommandDeps {
  return {
    config: () => loadConfig(),
    now: () => Date.now(),
    env: process.env,
    readSnapshot: defaultReadSnapshot,
    writeIntent: defaultWriteIntent,
    probeGateway: defaultProbeGateway,
    checkDaemon: defaultCheckDaemon,
    readIncompat: defaultReadIncompat,
    newId: () => randomUUID(),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code != null ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/* ------------------------------------------------------------------ status */

export interface StatusResult {
  ok: boolean;
  snapshot: StatusSnapshot | null;
  /** Age of the snapshot in ms, or null when there is none. */
  ageMs: number | null;
  stale: boolean;
  message: string | null;
}

export const STATUS_STALE_MS = 60_000;

export function statusCommand(deps: CommandDeps = defaultDeps()): StatusResult {
  const snapshot = deps.readSnapshot();
  if (snapshot == null) {
    return {
      ok: false,
      snapshot: null,
      ageMs: null,
      stale: true,
      message: "No status snapshot yet — is lifelined running? Try `lifeline doctor`.",
    };
  }
  const ageMs = Math.max(0, deps.now() - snapshot.updatedAt);
  const stale = ageMs > STATUS_STALE_MS;
  return {
    ok: true,
    snapshot,
    ageMs,
    stale,
    message: stale ? "Snapshot is stale; the daemon may not be running." : null,
  };
}

/* ----------------------------------------------------------------- control */

export interface ControlTarget {
  runId: string;
  /** null => the whole run. */
  agentId: string | null;
}

export type ParseTargetResult =
  | { ok: true; target: ControlTarget }
  | { ok: false; error: string };

/** `<runId>` or `<runId>/<agentId>`. Pure — exported for the eval harness. */
export function parseTarget(raw: string): ParseTargetResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "target is empty" };

  const parts = trimmed.split("/");
  if (parts.length > 2) {
    return { ok: false, error: `invalid target "${raw}" — expected <runId> or <runId>/<agentId>` };
  }

  const runId = (parts[0] ?? "").trim();
  if (runId === "") return { ok: false, error: `invalid target "${raw}" — missing runId` };

  if (parts.length === 1) return { ok: true, target: { runId, agentId: null } };

  const agentId = (parts[1] ?? "").trim();
  if (agentId === "") return { ok: false, error: `invalid target "${raw}" — missing agentId after "/"` };
  return { ok: true, target: { runId, agentId } };
}

export interface ControlResult {
  ok: boolean;
  kind: ControlIntent["kind"];
  target: ControlTarget | null;
  intent: ControlIntent | null;
  file: string | null;
  error: string | null;
}

/**
 * Write a control intent the daemon honours. Retry == Resume at the daemon (idempotent,
 * no-op safe), so the CLI's job is only to record the operator's request durably.
 */
export function controlCommand(
  kind: ControlIntent["kind"],
  rawTarget: string,
  deps: CommandDeps = defaultDeps(),
): ControlResult {
  const parsed = parseTarget(rawTarget);
  if (!parsed.ok) {
    return { ok: false, kind, target: null, intent: null, file: null, error: parsed.error };
  }

  const intent: ControlIntent = {
    id: deps.newId(),
    kind,
    target: { runId: parsed.target.runId, agentId: parsed.target.agentId },
    createdAt: deps.now(),
  };

  try {
    const file = deps.writeIntent(intent);
    return { ok: true, kind, target: parsed.target, intent, file, error: null };
  } catch (err) {
    return {
      ok: false,
      kind,
      target: parsed.target,
      intent,
      file: null,
      error: `could not write intent: ${errorMessage(err)}`,
    };
  }
}

export const retryCommand = (t: string, d?: CommandDeps): ControlResult => controlCommand("retry", t, d);
export const pauseCommand = (t: string, d?: CommandDeps): ControlResult => controlCommand("pause", t, d);
export const resumeCommand = (t: string, d?: CommandDeps): ControlResult => controlCommand("resume", t, d);

/* ------------------------------------------------------------------ doctor */

export type CheckLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Everything green — no failures and no warnings. */
  ok: boolean;
  /** At least one `fail`. index.ts exits non-zero on this. */
  hardFailure: boolean;
}

/** Trailing slashes and case differ harmlessly between an env var and our own URL. */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export async function doctorCommand(deps: CommandDeps = defaultDeps()): Promise<DoctorReport> {
  const cfg = deps.config();
  const url = gatewayUrl(cfg);
  const checks: DoctorCheck[] = [];

  const probe = await deps.probeGateway(`${url}/`);
  checks.push({
    id: "gateway",
    label: "gateway",
    level: probe.reachable ? "ok" : "fail",
    detail: probe.reachable
      ? `${url} responded (HTTP ${probe.status ?? "?"})`
      : `${url} unreachable — ${probe.error ?? "no response"}`,
  });

  const daemon = deps.checkDaemon(cfg, deps.now());
  checks.push({
    id: "daemon",
    label: "daemon",
    level: daemon.running ? "ok" : "fail",
    detail: daemon.detail,
  });

  // The installer's wrapper exports ANTHROPIC_BASE_URL per-process, so an unset value in
  // an ordinary shell is expected and only worth a warning. A value pointing somewhere
  // else is a real misroute: claude would bypass the gateway entirely.
  const baseUrl = deps.env.ANTHROPIC_BASE_URL;
  if (baseUrl == null || baseUrl.trim() === "") {
    checks.push({
      id: "base-url",
      label: "ANTHROPIC_BASE_URL",
      level: "warn",
      detail: `not set in this shell; the lifeline wrapper exports ${url} when launching claude`,
    });
  } else if (normalizeUrl(baseUrl) === normalizeUrl(url)) {
    checks.push({
      id: "base-url",
      label: "ANTHROPIC_BASE_URL",
      level: "ok",
      detail: `routed through the gateway (${baseUrl})`,
    });
  } else {
    checks.push({
      id: "base-url",
      label: "ANTHROPIC_BASE_URL",
      level: "fail",
      detail: `points at ${baseUrl}, not the gateway (${url}) — claude bypasses lifeline`,
    });
  }

  // A raw key in the environment can take precedence over the wrapper's routing and send
  // traffic straight to the API (see PLAN.md §3, "sharp edges").
  const apiKey = deps.env.ANTHROPIC_API_KEY;
  checks.push({
    id: "api-key",
    label: "ANTHROPIC_API_KEY",
    level: apiKey != null && apiKey.trim() !== "" ? "warn" : "ok",
    detail:
      apiKey != null && apiKey.trim() !== ""
        ? "set — a raw API key can bypass the gateway; unset it unless you need it"
        : "not set",
  });

  const incompat = deps.readIncompat();
  checks.push({
    id: "fingerprint",
    label: "CLI fingerprint",
    level: incompat == null ? "ok" : "warn",
    detail:
      incompat == null
        ? "no incompatibility flagged"
        : `unsupported version ${incompat.version ?? "unknown"} — lifeline running in reduced mode` +
          (incompat.reason != null ? ` (${incompat.reason})` : ""),
  });

  const hardFailure = checks.some((c) => c.level === "fail");
  return { checks, ok: !hardFailure && checks.every((c) => c.level === "ok"), hardFailure };
}
