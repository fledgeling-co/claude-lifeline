/**
 * Fail-closed version fingerprinting.
 *
 * A new Claude Code version lands in `~/.local/share/claude/versions/<ver>` roughly daily. lifeline
 * re-runs the contract probes against it and compares to the last verified baseline. Drift means
 * lifeline stops trusting its own adapters and says so — it never mis-applies recovery against a
 * contract it has not verified, and it never touches Anthropic's signed binary.
 *
 * Purity: `sha256`, `computeFingerprint` and `compareFingerprint` are pure. Everything that reads
 * the filesystem sits behind `FingerprintDeps` so the whole check can be driven from fixtures.
 */

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { readJson, writeJsonAtomic } from "../shared/io.js";
import { makeLogger } from "../shared/logger.js";
import { claudeProjectsDir, claudeVersionsDir, paths } from "../shared/paths.js";
import type { ProbeInputs, ProbeName } from "./contracts.js";
import { CONTRACT_PROBES, PROBE_NAMES, WORKFLOW_MARKERS, runProbe } from "./contracts.js";

const log = makeLogger("fingerprint");

/** Chunk size for the binary marker scan. The binary is ~265MB; it is never read whole. */
export const BINARY_SCAN_CHUNK = 1 << 20;

/**
 * Settle thresholds for the binary. A version file appears the instant its ~265MB download
 * starts, and under launchd we are woken by that very event — so without a settle gate the
 * marker scan reads a partial file, finds nothing, and raises contract drift against a version
 * that is in fact fine. A file nothing has touched for `STABILITY` ms is finished.
 */
export const BINARY_SETTLE_STABILITY_MS = 5_000;
export const BINARY_SETTLE_TIMEOUT_MS = 180_000;
export const BINARY_SETTLE_POLL_MS = 500;

/** Sampling bounds for journal discovery — a probe must never walk an unbounded tree. */
const MAX_JOURNAL_FILES = 200;
const MAX_LINES_PER_JOURNAL = 50;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

const VERSION_RE = /^\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

// ── Types ───────────────────────────────────────────────────────────────────────────────────

export interface ProbeResult {
  value: string;
  sha256: string;
}

export interface Fingerprint {
  version: string;
  probes: Record<ProbeName, ProbeResult>;
  /** Diagnostic only — never compared. */
  createdAt: number;
}

export interface FingerprintDiff {
  compatible: boolean;
  drifted: ProbeName[];
}

/** Written to ~/.lifeline/incompatible.json; `lifeline doctor` surfaces it. */
export interface IncompatFlag {
  version: string;
  drifted: ProbeName[];
  at: number;
  message: string;
}

/**
 * Whether the binary had stopped changing when we probed it.
 * - `settled` — quiescent, the probe read a complete file
 * - `absent`  — nothing to stat (non-standard install, or an injected test path)
 * - `timeout` — still changing after the timeout; we probe anyway and fail closed
 */
export type SettleOutcome = "settled" | "absent" | "timeout";

export interface VersionCheck {
  version: string | null;
  compatible: boolean;
  drifted: ProbeName[];
  baseline: Fingerprint | null;
  current: Fingerprint | null;
  /** The flag written this pass, or null when the version verified clean. */
  flag: IncompatFlag | null;
  reason: string;
  /** State of the binary when it was probed. Diagnostic — never part of the fingerprint. */
  settle: SettleOutcome;
}

export interface FingerprintDeps {
  versionsDir?: () => string;
  projectsDir?: () => string;
  /** User-owned launcher symlink; its target names the ACTIVE version. */
  symlinkPath?: string;
  /** Absolute path of a version's binary. */
  binaryPath?: (version: string) => string;
  readBinaryMarkers?: (path: string, markers: readonly string[]) => Promise<Record<string, boolean>>;
  listJournalPaths?: (projectsDir: string) => string[];
  readJournalEntries?: (journalPaths: readonly string[]) => Record<string, unknown>[];
  /** Block until the binary stops changing. Injected in tests so nothing ever sleeps. */
  waitForBinarySettle?: (path: string) => Promise<SettleOutcome>;
  now?: () => number;
}

// ── Pure core ───────────────────────────────────────────────────────────────────────────────

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Pure: runs every probe over already-gathered inputs. No I/O. */
export function computeFingerprint(
  version: string,
  inputs: ProbeInputs,
  now: () => number = Date.now,
): Fingerprint {
  // Single localized assertion: the loop fills every key of the finite ProbeName union.
  const probes = {} as Record<ProbeName, ProbeResult>;
  for (const name of PROBE_NAMES) {
    const value = runProbe(name, inputs);
    probes[name] = { value, sha256: sha256(value) };
  }
  return { version, probes, createdAt: now() };
}

/**
 * Pure. Drift = a probe whose sha256 changed. A probe missing from either side also counts as
 * drift: a fingerprint file that predates a probe has not verified it, and unverified is not
 * the same as compatible.
 */
export function compareFingerprint(baseline: Fingerprint, current: Fingerprint): FingerprintDiff {
  const drifted: ProbeName[] = [];
  for (const name of PROBE_NAMES) {
    // Loaded-from-disk fingerprints are untrusted data; the static type over-promises.
    const b = baseline.probes[name] as ProbeResult | undefined;
    const c = current.probes[name] as ProbeResult | undefined;
    if (!b || !c || b.sha256 !== c.sha256) drifted.push(name);
  }
  return { compatible: drifted.length === 0, drifted };
}

/** Pure. Numeric-segment ordering, newest first when used as a descending comparator. */
export function compareVersions(a: string, b: string): number {
  const as = a.split(/[^0-9]+/).filter((s) => s.length > 0);
  const bs = b.split(/[^0-9]+/).filter((s) => s.length > 0);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = Number(as[i] ?? 0);
    const bv = Number(bs[i] ?? 0);
    if (av !== bv) return av - bv;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isVersionName(name: string): boolean {
  return VERSION_RE.test(name);
}

export function isFingerprint(value: unknown): value is Fingerprint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Fingerprint>;
  return typeof v.version === "string" && typeof v.probes === "object" && v.probes !== null;
}

/** Pure: the human sentence shown by the watcher notification and `lifeline doctor`. */
export function driftMessage(version: string, drifted: readonly ProbeName[]): string {
  const detail = drifted
    .map((name) => `${name} (${CONTRACT_PROBES[name].describe()})`)
    .join("; ");
  return `unsupported Claude Code version ${version} — lifeline running in reduced mode; contract drift: ${detail}`;
}

// ── Bounded binary marker scan ──────────────────────────────────────────────────────────────

/**
 * Stream a file in chunks and report which markers appear. Keeps a (maxMarkerLen-1) byte tail so
 * a marker straddling a chunk boundary is still found, copies that tail so the large chunk can be
 * released, and stops as soon as every marker is seen. Never loads the file.
 *
 * An unreadable file leaves every marker false, which reads as drift — fail closed.
 */
export async function readBinaryMarkers(
  path: string,
  markers: readonly string[],
  chunkSize: number = BINARY_SCAN_CHUNK,
): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {};
  for (const m of markers) found[m] = false;

  const needles = [...new Set(markers)]
    .filter((m) => m.length > 0)
    .map((m) => ({ marker: m, bytes: Buffer.from(m, "utf8") }));
  if (needles.length === 0) return found;

  const overlap = Math.max(...needles.map((n) => n.bytes.length)) - 1;
  let remaining = needles.length;
  let tail = Buffer.alloc(0);

  try {
    const stream = createReadStream(path, { highWaterMark: chunkSize });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const hay = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
      for (const needle of needles) {
        if (found[needle.marker] === true) continue;
        if (hay.indexOf(needle.bytes) !== -1) {
          found[needle.marker] = true;
          remaining -= 1;
        }
      }
      if (remaining === 0) break; // breaking the for-await destroys the stream
      tail =
        overlap > 0
          ? Buffer.from(hay.subarray(Math.max(0, hay.length - overlap)))
          : Buffer.alloc(0);
    }
  } catch (err) {
    log.warn(`binary marker scan failed for ${path}`, String(err));
  }
  return found;
}

// ── Settle gate ─────────────────────────────────────────────────────────────────────────────

export interface SettleOptions {
  stabilityMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  /** Injected in tests. Returns null when the path cannot be stat'd. */
  statFile?: (path: string) => { mtimeMs: number } | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultStatFile(path: string): { mtimeMs: number } | null {
  try {
    return { mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until `path` has been untouched for `stabilityMs`.
 *
 * Age-of-mtime rather than a poll-and-compare loop: a file that settled hours ago returns on the
 * first stat with no sleep at all, so the common case (a routine check against an installed
 * version) costs nothing, while a file being actively written keeps having its mtime refreshed
 * and cannot satisfy the test until the writer stops.
 *
 * `absent` is not an error — a non-standard install has no such file and the probes below fail
 * closed on their own.
 */
export async function waitForBinarySettle(
  path: string,
  opts: SettleOptions = {},
): Promise<SettleOutcome> {
  const stabilityMs = opts.stabilityMs ?? BINARY_SETTLE_STABILITY_MS;
  const timeoutMs = opts.timeoutMs ?? BINARY_SETTLE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? BINARY_SETTLE_POLL_MS;
  const statFile = opts.statFile ?? defaultStatFile;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const started = now();
  for (;;) {
    const stat = statFile(path);
    if (stat === null) return "absent";
    const age = now() - stat.mtimeMs;
    // A future mtime (clock skew, a copy preserving timestamps) can never age into stability;
    // blocking for the full timeout to learn that helps nobody.
    if (age >= stabilityMs || age < 0) return "settled";
    if (now() - started >= timeoutMs) return "timeout";
    await sleep(pollMs);
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────────────────────

/** Version strings come from the filesystem; never let one escape its directory. */
function sanitizeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function fingerprintFile(version: string): string {
  return join(paths.fingerprintsDir(), `${sanitizeVersion(version)}.json`);
}

export function saveFingerprint(fp: Fingerprint): void {
  writeJsonAtomic(fingerprintFile(fp.version), fp);
}

export function loadFingerprint(version: string): Fingerprint | null {
  const value = readJson<unknown>(fingerprintFile(version), null);
  return isFingerprint(value) ? value : null;
}

/** Stored baselines, newest version first. */
export function listFingerprints(): string[] {
  return safeReaddir(paths.fingerprintsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort((a, b) => compareVersions(b, a));
}

/** The most recent verified baseline, used when a brand-new version has none of its own. */
export function loadLatestFingerprint(): Fingerprint | null {
  for (const version of listFingerprints()) {
    const fp = loadFingerprint(version);
    if (fp) return fp;
  }
  return null;
}

export function readIncompatFlag(): IncompatFlag | null {
  const value = readJson<IncompatFlag | null>(paths.incompatFlag(), null);
  return value && typeof value.version === "string" ? value : null;
}

export function writeIncompatFlag(flag: IncompatFlag): void {
  writeJsonAtomic(paths.incompatFlag(), flag);
}

export function clearIncompatFlag(): void {
  try {
    rmSync(paths.incompatFlag(), { force: true });
  } catch {
    // Nothing to clear.
  }
}

// ── Default (injectable) I/O ────────────────────────────────────────────────────────────────

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReaddirDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function defaultSymlinkPath(): string {
  return join(homedir(), ".local", "bin", "claude");
}

export function defaultBinaryPath(version: string): string {
  return join(claudeVersionsDir(), version);
}

/**
 * Walk exactly the levels of the documented layout —
 * `<projects>/<project>/<session>/subagents/workflows/wf_*` — never recursively, and stop at
 * MAX_JOURNAL_FILES.
 */
export function defaultListJournalPaths(projectsDir: string): string[] {
  const out: string[] = [];
  for (const project of safeReaddirDirs(projectsDir)) {
    for (const session of safeReaddirDirs(join(projectsDir, project))) {
      const workflows = join(projectsDir, project, session, "subagents", "workflows");
      for (const run of safeReaddirDirs(workflows)) {
        const journal = join(workflows, run, "journal.jsonl");
        try {
          if (statSync(journal).isFile()) out.push(journal);
        } catch {
          continue;
        }
        if (out.length >= MAX_JOURNAL_FILES) return out;
      }
    }
  }
  return out;
}

export function defaultReadJournalEntries(journalPaths: readonly string[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const path of journalPaths) {
    try {
      if (statSync(path).size > MAX_JOURNAL_BYTES) continue;
      const lines = readFileSync(path, "utf8").split("\n").slice(0, MAX_LINES_PER_JOURNAL);
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            entries.push(parsed as Record<string, unknown>);
          }
        } catch {
          // A half-written last line is normal on a live run.
        }
      }
    } catch {
      continue;
    }
  }
  return entries;
}

/** Gather every probe input for a version. This is the only I/O `computeFingerprint` needs. */
export async function gatherProbeInputs(
  version: string,
  deps: FingerprintDeps = {},
): Promise<ProbeInputs> {
  const projectsDir = (deps.projectsDir ?? claudeProjectsDir)();
  const listJournals = deps.listJournalPaths ?? defaultListJournalPaths;
  const readEntries = deps.readJournalEntries ?? defaultReadJournalEntries;
  const scan = deps.readBinaryMarkers ?? readBinaryMarkers;
  const binary = (deps.binaryPath ?? defaultBinaryPath)(version);

  const journalPaths = listJournals(projectsDir);
  const markers = await scan(binary, WORKFLOW_MARKERS);

  return {
    "journal-line-shape": { entries: readEntries(journalPaths) },
    "disk-layout": { journalPaths },
    "workflow-tool-anchors": { markers },
  };
}

/**
 * The installed version: the newest entry in the versions dir, else the launcher symlink target.
 * Newest-first is deliberate — the watcher fires when an update lands, and verifying it before it
 * becomes active is the whole point. After install the symlink points at lifeline's wrapper, whose
 * name is not a version, so the fallback correctly declines it.
 */
export function detectInstalledVersion(deps: FingerprintDeps = {}): string | null {
  const dir = (deps.versionsDir ?? claudeVersionsDir)();
  const versions = safeReaddir(dir)
    .filter(isVersionName)
    .sort((a, b) => compareVersions(b, a));
  const newest = versions[0];
  if (newest !== undefined) return newest;

  try {
    const target = basename(readlinkSync(deps.symlinkPath ?? defaultSymlinkPath()));
    return isVersionName(target) ? target : null;
  } catch {
    return null;
  }
}

// ── The check ───────────────────────────────────────────────────────────────────────────────

/**
 * Probe the installed version and reconcile against the stored baseline.
 *
 * - no version detectable  -> flag (we cannot verify, so we must not claim compatible)
 * - no baseline at all     -> record this fingerprint as the baseline (trust on first use)
 * - baseline matches       -> bless the version, clear the flag
 * - baseline drifted       -> write the flag; the verified baseline is left untouched
 *
 * The binary is settled first. launchd wakes us on the filesystem event that STARTS the download,
 * so probing immediately reads a partial file and reports drift against a version that is fine.
 */
export async function checkInstalledVersion(deps: FingerprintDeps = {}): Promise<VersionCheck> {
  const now = deps.now ?? Date.now;
  const version = detectInstalledVersion(deps);

  if (version === null) {
    const message =
      "could not determine the installed Claude Code version — lifeline running in reduced mode";
    const flag: IncompatFlag = { version: "unknown", drifted: [], at: now(), message };
    writeIncompatFlag(flag);
    log.warn(message);
    return {
      version: null,
      compatible: false,
      drifted: [],
      baseline: null,
      current: null,
      flag,
      reason: "version-undetectable",
      settle: "absent",
    };
  }

  const settleFn = deps.waitForBinarySettle ?? waitForBinarySettle;
  const settle = await settleFn((deps.binaryPath ?? defaultBinaryPath)(version));
  if (settle === "timeout") {
    log.warn(`binary for ${version} was still changing after the settle timeout; probing anyway`);
  }

  const inputs = await gatherProbeInputs(version, deps);
  const current = computeFingerprint(version, inputs, now);
  const stored = loadFingerprint(version);
  const baseline = stored ?? loadLatestFingerprint();

  if (baseline === null) {
    // Never bless a read we know was unreliable. A timeout means the binary was STILL being
    // written, so its markers are missing for a reason that has nothing to do with the
    // contract — recording that as the baseline would pin permanent false drift on a version
    // that is fine, which is the inverse of the bug the settle gate exists to prevent.
    if (settle === "timeout") {
      log.warn(`not recording a baseline for ${version}: the binary never settled`);
      return {
        version,
        compatible: true,
        drifted: [],
        baseline: null,
        current,
        flag: null,
        reason: "unsettled-no-baseline",
        settle,
      };
    }
    saveFingerprint(current);
    clearIncompatFlag();
    log.info(`recorded contract baseline for ${version}`);
    return {
      version,
      compatible: true,
      drifted: [],
      baseline: null,
      current,
      flag: null,
      reason: "baseline-recorded",
      settle,
    };
  }

  const diff = compareFingerprint(baseline, current);

  if (diff.compatible) {
    if (stored === null) saveFingerprint(current); // bless the new version against a matching contract
    clearIncompatFlag();
    log.info(`version ${version} verified against baseline ${baseline.version}`);
    return {
      version,
      compatible: true,
      drifted: [],
      baseline,
      current,
      flag: null,
      reason: stored === null ? "verified-and-blessed" : "verified",
      settle,
    };
  }

  const message = driftMessage(version, diff.drifted);
  const flag: IncompatFlag = { version, drifted: diff.drifted, at: now(), message };
  writeIncompatFlag(flag);
  log.warn(message);
  return {
    version,
    compatible: false,
    drifted: diff.drifted,
    baseline,
    current,
    flag,
    reason: "contract-drift",
    settle,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────────────────
// install.sh runs `--baseline` after install; CI runs `--validate-latest` and needs a
// non-zero exit on drift so the job actually fails closed.

function cliIsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href || entry.endsWith("fingerprint/index.js");
  } catch {
    return false;
  }
}

if (cliIsMain()) {
  const arg = process.argv[2];
  const check = await checkInstalledVersion();
  const summary = {
    mode: arg ?? "--baseline",
    version: check.version,
    compatible: check.compatible,
    drifted: check.drifted,
    reason: check.reason,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (arg === "--validate-latest" && !check.compatible) process.exit(1);
}
