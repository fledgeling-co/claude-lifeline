/**
 * Seam B's read side: parse a live workflow run directory off disk and find the agents the
 * runtime lost silently.
 *
 * On-disk contract (stable across CLI releases, FINDINGS.md "Disk layout"):
 *   <projects>/<project>/<session>/subagents/workflows/wf_<id>/journal.jsonl
 *   <projects>/<project>/<session>/subagents/workflows/wf_<id>/agent-<agentId>.jsonl
 *   <projects>/<project>/<session>/workflows/wf_<id>.json            (run snapshot)
 *
 * Every read here is defensive: a live run appends to these files while we read them, so a
 * truncated trailing line is normal and must never throw.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Classification } from "../shared/classifier.js";
import { classify } from "../shared/classifier.js";
import { readJson } from "../shared/io.js";

/** How much of a transcript we read from each end. Transcripts can be megabytes. */
const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 32 * 1024;

/** Human item ids the workflows carry, e.g. DIO-0012 / PH-010. */
const ITEM_RE = /\b([A-Z]{2,10}-\d{3,4})\b/;

/**
 * Text markers that identify an API-error tail. These are only ever consulted alongside a
 * STRUCTURAL signal (see `apiErrorFromLine`) — a healthy agent's final message can discuss
 * rate limits in prose, and matching that as a failure would invent losses.
 */
const API_ERROR_TEXT_MARKERS = [
  "api error",
  "session limit",
  "usage limit",
  "rate limit",
  "temporarily limiting requests",
  "connectionrefused",
  "connection refused",
  "connection closed",
  "connection error",
  "prompt is too long",
  "prompt too long",
  "autocompact is thrashing",
  "accounts for binding are exhausted",
  "all-accounts-exhausted",
  "overloaded",
  "internal server error",
  "server error mid-response",
  "response stalled mid-stream",
];

export interface LostAgent {
  /** sha256 prompt-chain key from the journal's `started` line — the ledger key. */
  key: string;
  agentId: string;
  item: string | null;
  errorText: string;
  classification: Classification;
  transcriptFile: string;
  /** Last write to the transcript; how we know the agent is not merely slow. */
  mtimeMs: number;
}

export interface RunScan {
  runId: string;
  project: string;
  sessionId: string;
  runDir: string;
  /** From the sibling <session>/workflows/<runId>.json snapshot, when present. */
  scriptPath: string | null;
  args: unknown;
  /** Repo the agents were working in, read from the transcript rather than the mangled dir name. */
  cwd: string | null;
  /** Agents with a `started` line and no `result` line, and no API-error tail: still live. */
  liveAgents: number;
  /** Agents with a journaled `result`. */
  completedAgents: number;
  /** Prompt-chain keys with a journaled `result` — the only evidence an agent truly finished. */
  resultKeys: string[];
  lost: LostAgent[];
}

/* ------------------------------------------------------------------ *
 * Pure parsing helpers (exported for unit tests)
 * ------------------------------------------------------------------ */

export interface RunDirParts {
  runId: string;
  project: string;
  sessionId: string;
  sessionDir: string;
}

/** Split `.../<project>/<session>/subagents/workflows/wf_x` into its parts. */
export function parseRunDirPath(runDir: string): RunDirParts | null {
  const runId = basename(runDir);
  if (!runId.startsWith("wf_")) return null;
  const workflowsDir = dirname(runDir);
  if (basename(workflowsDir) !== "workflows") return null;
  const subagentsDir = dirname(workflowsDir);
  if (basename(subagentsDir) !== "subagents") return null;
  const sessionDir = dirname(subagentsDir);
  const sessionId = basename(sessionDir);
  const project = basename(dirname(sessionDir));
  if (!sessionId || !project) return null;
  return { runId, project, sessionId, sessionDir };
}

export interface JournalIndex {
  /** agentId -> prompt-chain key, from `started` lines. */
  keyByAgent: Map<string, string>;
  /** Keys that produced a real result — these agents are not lost. */
  resultKeys: Set<string>;
  startedKeys: Set<string>;
}

/** Parse journal.jsonl. Unparseable lines (a partially-written tail) are skipped. */
export function parseJournal(text: string): JournalIndex {
  const keyByAgent = new Map<string, string>();
  const resultKeys = new Set<string>();
  const startedKeys = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const key = typeof obj["key"] === "string" ? obj["key"] : null;
    if (!key) continue;
    const agentId = typeof obj["agentId"] === "string" ? obj["agentId"] : null;
    if (obj["type"] === "started") {
      startedKeys.add(key);
      if (agentId) keyByAgent.set(agentId, key);
    } else if (obj["type"] === "result") {
      resultKeys.add(key);
      if (agentId) keyByAgent.set(agentId, key);
    }
  }
  return { keyByAgent, resultKeys, startedKeys };
}

export interface ApiErrorSignature {
  errorText: string;
  status: number | undefined;
}

/**
 * Recognise the synthetic assistant message the runtime writes when an API call fails
 * (`{isApiErrorMessage:true, apiErrorStatus:429, error:"rate_limit", message:{model:"<synthetic>",
 * content:[{text:"You've hit your session limit …"}]}}`).
 *
 * A structural signal is REQUIRED. Text markers alone would misread an agent that merely
 * wrote about rate limits in its final answer.
 */
export function apiErrorFromLine(line: unknown): ApiErrorSignature | null {
  if (!isRecord(line)) return null;

  const status = typeof line["apiErrorStatus"] === "number" ? line["apiErrorStatus"] : undefined;
  const flagged = line["isApiErrorMessage"] === true;
  const message = isRecord(line["message"]) ? line["message"] : null;
  const synthetic = message !== null && message["model"] === "<synthetic>";
  const text = messageText(message);

  const structural = flagged || status !== undefined;
  if (!structural && !(synthetic && hasMarker(text))) return null;

  const errorCode = typeof line["error"] === "string" ? line["error"] : "";
  const errorText = [text, errorCode].filter((s) => s.length > 0).join(" | ");
  return { errorText: errorText || `api error${status !== undefined ? ` ${status}` : ""}`, status };
}

/** Flatten a transcript message's content blocks into plain text. */
export function messageText(message: Record<string, unknown> | null): string {
  if (!message) return "";
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (isRecord(block) && typeof block["text"] === "string") parts.push(block["text"]);
  }
  return parts.join("\n");
}

export function parseItemId(text: string): string | null {
  const m = ITEM_RE.exec(text);
  return m && m[1] ? m[1] : null;
}

/** The `cwd` every transcript line carries — the repo the agent worked in. */
export function parseCwd(text: string): string | null {
  for (const line of lastLines(text, 40)) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(obj) && typeof obj["cwd"] === "string" && obj["cwd"].length > 0) return obj["cwd"];
  }
  return null;
}

/**
 * The lost-agent predicate (feature spec §B): an API-error tail, no journaled result for the
 * agent's key, and a transcript that has been quiet longer than the live window. All three
 * are needed — the first two alone would flag an agent that is still mid-retry, and the last
 * alone would flag any slow agent.
 */
export function isLost(input: {
  hasApiErrorTail: boolean;
  hasResult: boolean;
  mtimeMs: number;
  now: number;
  liveWindowMs: number;
}): boolean {
  if (!input.hasApiErrorTail || input.hasResult) return false;
  return input.now - input.mtimeMs > input.liveWindowMs;
}

/* ------------------------------------------------------------------ *
 * Bounded, defensive file reads
 * ------------------------------------------------------------------ */

export interface FileSlice {
  text: string;
  mtimeMs: number;
  size: number;
}

/** Read up to `maxBytes` from one end of a file. Returns null on any fs error. */
export function readSlice(file: string, maxBytes: number, from: "head" | "tail"): FileSlice | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    const size = stat.size;
    const length = Math.min(maxBytes, size);
    const position = from === "head" ? 0 : Math.max(0, size - length);
    const buf = Buffer.allocUnsafe(length);
    const read = length > 0 ? readSync(fd, buf, 0, length, position) : 0;
    let text = buf.subarray(0, read).toString("utf8");
    // A tail that did not start at byte 0 begins mid-line; drop that fragment.
    if (from === "tail" && position > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return { text, mtimeMs: stat.mtimeMs, size };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Last `count` non-empty lines of a chunk, newest last. */
export function lastLines(text: string, count: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - count));
}

/**
 * Walk a transcript tail backwards for the newest API-error line. Returns null if the newest
 * meaningful line is not an API error — an agent that errored and then recovered on its own
 * is not lost.
 */
export function apiErrorFromTail(tailText: string): ApiErrorSignature | null {
  const lines = lastLines(tailText, 8);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    if (!raw) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const sig = apiErrorFromLine(obj);
    if (sig) return sig;
    // The newest parseable line is a normal message → the agent did not die on an API error.
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

interface RunSnapshot {
  scriptPath?: unknown;
  args?: unknown;
  workflowProgress?: unknown;
}

export interface ScanOptions {
  now: number;
  liveWindowMs: number;
}

/**
 * Scan one wf_<id> directory. Returns null when the path is not a run dir or has no journal
 * yet (a run that has only just been created).
 */
export function scanRunDir(runDir: string, opts: ScanOptions): RunScan | null {
  const parts = parseRunDirPath(runDir);
  if (!parts) return null;

  const journalSlice = readSlice(join(runDir, "journal.jsonl"), 4 * 1024 * 1024, "tail");
  if (!journalSlice) return null;
  const index = parseJournal(journalSlice.text);

  const snapshotFile = join(parts.sessionDir, "workflows", `${parts.runId}.json`);
  const snapshot = readJson<RunSnapshot | null>(snapshotFile, null);
  const scriptPath =
    snapshot && typeof snapshot.scriptPath === "string" ? snapshot.scriptPath : null;
  const args = snapshot ? snapshot.args : undefined;
  const labels = labelsByAgent(snapshot);

  let transcripts: string[];
  try {
    transcripts = readdirSync(runDir).filter((f) => /^agent-.+\.jsonl$/.test(f));
  } catch {
    return null;
  }

  const lost: LostAgent[] = [];
  let liveAgents = 0;
  let completedAgents = 0;
  let cwd: string | null = null;

  for (const fileName of transcripts) {
    const agentId = fileName.slice("agent-".length, -".jsonl".length);
    const key = index.keyByAgent.get(agentId);
    // Without a `started` line we have no prompt-chain key, so there is nothing to key the
    // ledger on and no way to resume it — skip rather than guess.
    if (!key) continue;

    const hasResult = index.resultKeys.has(key);
    if (hasResult) {
      completedAgents += 1;
      continue;
    }

    const file = join(runDir, fileName);
    const tail = readSlice(file, TAIL_BYTES, "tail");
    if (!tail) continue;
    if (!cwd) cwd = parseCwd(tail.text);

    const sig = apiErrorFromTail(tail.text);
    if (
      !isLost({
        hasApiErrorTail: sig !== null,
        hasResult,
        mtimeMs: tail.mtimeMs,
        now: opts.now,
        liveWindowMs: opts.liveWindowMs,
      })
    ) {
      liveAgents += 1;
      continue;
    }
    if (!sig) continue; // unreachable given isLost, but keeps the narrowing honest

    const head = readSlice(file, HEAD_BYTES, "head");
    const label = labels.get(agentId) ?? null;
    const item =
      (head ? parseItemId(head.text) : null) ??
      (label ? (parseItemId(label) ?? label) : null);

    lost.push({
      key,
      agentId,
      item,
      errorText: sig.errorText,
      classification: classify({ status: sig.status, message: sig.errorText }),
      transcriptFile: file,
      mtimeMs: tail.mtimeMs,
    });
  }

  return {
    runId: parts.runId,
    project: parts.project,
    sessionId: parts.sessionId,
    runDir,
    scriptPath,
    args,
    cwd,
    liveAgents,
    completedAgents,
    resultKeys: [...index.resultKeys],
    lost,
  };
}

/** `workflowProgress` carries a human label per agent — a fallback item id. */
function labelsByAgent(snapshot: RunSnapshot | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!snapshot || !Array.isArray(snapshot.workflowProgress)) return out;
  for (const row of snapshot.workflowProgress) {
    if (!isRecord(row)) continue;
    const agentId = row["agentId"];
    const label = row["label"];
    if (typeof agentId === "string" && typeof label === "string") out.set(agentId, label);
  }
  return out;
}

function hasMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return API_ERROR_TEXT_MARKERS.some((m) => lower.includes(m));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
