/**
 * Command implementations for the `lifeline` CLI (Seam C).
 *
 * Every command takes an injectable `CommandDeps` and returns a plain result object;
 * `index.ts` owns all printing and exit codes. That split keeps the command logic
 * testable without a filesystem, a gateway, or a running daemon.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { gatewayUrl, loadConfig } from "../shared/config.js";
import type { LifelineConfig } from "../shared/config.js";
import { compareVersions, isVersionName } from "../fingerprint/index.js";
import { ensureDir, readJson, writeJsonAtomic } from "../shared/io.js";
import { claudeVersionsDir, paths } from "../shared/paths.js";
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
  /** Whether the optional menu-bar status window is installed. */
  checkMenubar(): { installed: boolean };
  /** Which Claude Code the wrapper would launch, versus the newest one installed. */
  checkClaudeVersion(): ClaudeVersionCheck;
  /** ANTHROPIC_BASE_URL from ~/.claude/settings.json, which outranks the environment. */
  readSettingsBaseUrl(): string | null;
  newId(): string;
}

/**
 * lifeline owns ~/.local/bin/claude, so Claude Code's own updater can no longer repoint it.
 * That makes "the version you would launch" a thing lifeline is now responsible for, and a
 * thing that can silently fall behind. This check is what makes falling behind loud.
 */
export interface ClaudeVersionCheck {
  /** The version the wrapper resolves at launch, or null when it cannot be determined. */
  active: string | null;
  /** The newest version present on disk, or null when there is no versions directory. */
  newest: string | null;
  /** True for a non-standard install (npm/homebrew): no versions dir to fall behind. */
  unmanaged: boolean;
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
    checkMenubar: defaultCheckMenubar,
    checkClaudeVersion: defaultCheckClaudeVersion,
    readSettingsBaseUrl: defaultReadSettingsBaseUrl,
    newId: () => randomUUID(),
  };
}

/**
 * Compare the version the wrapper LAST LAUNCHED (it records each resolution) against the newest
 * version on disk. Reading the wrapper's own trace, rather than re-deriving what it ought to
 * pick, is deliberate: re-deriving would agree with itself and could never catch the wrapper
 * pinning an old binary, which is exactly the failure this check exists to make loud.
 */
function defaultCheckClaudeVersion(): ClaudeVersionCheck {
  let versions: string[] = [];
  try {
    versions = readdirSync(claudeVersionsDir())
      .filter(isVersionName)
      .sort((a, b) => compareVersions(b, a));
  } catch {
    versions = [];
  }
  const newest = versions[0] ?? null;

  let active: string | null = null;
  try {
    const recorded = readFileSync(join(paths.home(), "real-claude"), "utf8").trim();
    if (recorded !== "") {
      const base = basename(recorded);
      active = isVersionName(base) ? base : null;
    }
  } catch {
    // No record yet — claude has not been launched through the wrapper.
  }

  return { active, newest, unmanaged: newest === null };
}

/** Read-only and tolerant: an unreadable or malformed settings file simply has no base URL. */
function defaultReadSettingsBaseUrl(): string | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const env = (raw as { env?: unknown }).env;
    if (typeof env !== "object" || env === null) return null;
    const value = (env as { ANTHROPIC_BASE_URL?: unknown }).ANTHROPIC_BASE_URL;
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

function defaultCheckMenubar(): { installed: boolean } {
  try {
    return { installed: statSync(join(paths.home(), "bin", "lifeline-menubar")).isFile() };
  } catch {
    return { installed: false };
  }
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

/** Where a base URL can come from, in the order Claude Code itself resolves them. */
export interface BaseUrlSources {
  /** ~/.claude/settings.json `env`. Claude Code applies this itself; it outranks the shell. */
  settings: string | null;
  /** This shell's environment. Only reaches claude when settings.json does not set one. */
  shell: string | null;
}

/**
 * Pure. Judges the route claude will ACTUALLY take, which is decided by settings.json first
 * and only then by the environment. The old check read the shell alone, so a proxy sitting in
 * settings.json read as a scary `fail` in one shell and a clean `ok` in another while claude
 * bypassed the gateway in both.
 */
export function baseUrlVerdict(
  sources: BaseUrlSources,
  gateway: string,
  upstream: string,
): { level: CheckLevel; detail: string } {
  const effective = sources.settings ?? sources.shell;
  const via = sources.settings != null ? "settings.json" : "this shell";

  if (effective == null || effective.trim() === "") {
    return {
      level: "ok",
      detail: `unset; the wrapper exports ${gateway} when launching claude (upstream ${upstream})`,
    };
  }
  if (normalizeUrl(effective) === normalizeUrl(gateway)) {
    return { level: "ok", detail: `routed through the gateway via ${via} (upstream ${upstream})` };
  }
  // A warning, not a failure: the wrapper re-chains this at the next launch, so it is a
  // transient state with a known repair rather than something the user must go and fix.
  return {
    level: "warn",
    detail:
      `${via} points at ${effective}, not the gateway (${gateway}), so claude is bypassing lifeline; ` +
      `launching claude re-chains it and makes ${effective} the upstream`,
  };
}

/**
 * Pure. A record behind the newest version reads the same whether claude simply has not been
 * launched since the update or the wrapper is pinning — and the user's position is identical
 * either way — so the message covers both and says which one a relaunch would prove.
 */
export function claudeVersionVerdict(
  check: ClaudeVersionCheck,
): { level: CheckLevel; detail: string } {
  if (check.unmanaged) {
    return { level: "ok", detail: "no versions directory — non-standard install, nothing to track" };
  }
  if (check.active === null) {
    return {
      level: "ok",
      detail: `newest installed is ${check.newest ?? "unknown"}; claude has not been launched through lifeline yet`,
    };
  }
  if (check.newest === null || compareVersions(check.active, check.newest) >= 0) {
    return { level: "ok", detail: `running ${check.active} (newest installed)` };
  }
  return {
    level: "warn",
    detail:
      `last launched ${check.active}, but ${check.newest} is installed — run claude once to pick it up; ` +
      `if it still says ${check.active} afterwards the wrapper is pinning and lifeline is holding you back`,
  };
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

  checks.push({
    id: "base-url",
    label: "ANTHROPIC_BASE_URL",
    ...baseUrlVerdict(
      { settings: deps.readSettingsBaseUrl(), shell: deps.env.ANTHROPIC_BASE_URL ?? null },
      url,
      deps.config().upstream,
    ),
  });

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

  const claude = deps.checkClaudeVersion();
  checks.push({
    id: "claude-version",
    label: "Claude Code version",
    ...claudeVersionVerdict(claude),
  });

  // The status window is optional (needs swiftc at install time), so its absence is a
  // plain note, never a failure.
  const menubar = deps.checkMenubar();
  checks.push({
    id: "menubar",
    label: "status window",
    level: "ok",
    detail: menubar.installed
      ? "menu-bar app installed (look for the pulse in your menu bar)"
      : "not installed — optional; install Xcode Command Line Tools and re-run install.sh to add it",
  });

  const hardFailure = checks.some((c) => c.level === "fail");
  return { checks, ok: !hardFailure && checks.every((c) => c.level === "ok"), hardFailure };
}
