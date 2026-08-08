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

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
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
 * A workflow agent's own identity, when its prompt declares one. Fleet prompts open with a
 * `UNIT:` line (e.g. `UNIT: queued-tail-3`) naming the agent's slice of work — that IS the
 * agent, and it must win over any ticket id that merely appears in the prompt's scope text.
 * Tolerant of raw JSONL (the transcript slice is unparsed, so its newline is an escaped `\n`).
 */
const UNIT_RE = /(?:^|\\n|[\r\n"])[ \t]*UNIT:[ \t]*([^\s"\\]+)/i;

/** The 1m-context window; a run whose fill exceeds the default limit is re-scaled to this. */
const LARGE_CONTEXT_LIMIT = 1_000_000;

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
  /** Agents alive but quiet past the stall window — recovered by a scheduled nudge. */
  stalled: StalledAgent[];
  /** Per-agent telemetry for the status view (durations, context fill, tail), all agents. */
  agents: AgentTelemetry[];
  /** Earliest transcript timestamp across the run, ms — the run's start for its duration. */
  startedAtMs: number | null;
  /** Last cleaned lines of the top-level claude session that launched this run. */
  callerTail: string[];
  /** The workflow's own name (meta.name), e.g. "perch-fleet-run7". */
  workflowName: string | null;
  /** The workspace (repo) the run worked in, e.g. "diolog-swe-bench" — basename of cwd. */
  workspace: string | null;
  /** Total agents the workflow planned, from the snapshot — null when not yet known. */
  plannedCount: number | null;
}

export interface StalledAgent {
  key: string;
  agentId: string;
  item: string | null;
  quietForMs: number;
  transcriptFile: string;
  mtimeMs: number;
}

/** Everything the status view needs about one agent, independent of the ledger. */
export interface AgentTelemetry {
  agentId: string;
  key: string | null;
  item: string | null;
  /** "done" | "lost" | "stalled" | "live" — the scan's view before the ledger overrides it. */
  kind: "done" | "lost" | "stalled" | "live";
  firstTsMs: number | null;
  lastTsMs: number | null;
  durationMs: number | null;
  /** Context-window fill 0..1 from the latest usage record, or null when none seen. */
  contextFrac: number | null;
  /** Actual context tokens in the window right now (input + both cache tiers). */
  contextTokens: number | null;
  quietForMs: number | null;
  tail: string[];
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

/** The agent's declared `UNIT:` identity from its prompt, trimmed and length-capped. */
export function parseUnit(text: string): string | null {
  const m = UNIT_RE.exec(text);
  if (!m || !m[1]) return null;
  const unit = m[1].trim();
  return unit ? unit.slice(0, 60) : null;
}

/**
 * The name to show for an agent, best-first: its own declared `UNIT:` identity, then a ticket
 * id or the workflow's per-agent label. A ticket merely mentioned in the prompt's scope is the
 * last thing to fall back to, never the first — that was the bug that named agents "WEB-4763".
 */
export function agentIdentity(headText: string | null, label: string | null): string | null {
  if (headText) {
    const unit = parseUnit(headText);
    if (unit) return unit;
  }
  if (label) {
    const unit = parseUnit(label);
    if (unit) return unit;
    return parseItemId(label) ?? label;
  }
  return headText ? parseItemId(headText) : null;
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

/** A transcript line's ISO `timestamp`, in ms, or null. */
function lineTsMs(obj: Record<string, unknown>): number | null {
  const ts = obj["timestamp"];
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Context-window fill from an assistant message's usage record. Claude Code writes the full
 * usage on every assistant turn (`input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens` is the prompt actually sent, i.e. how full the window is). Divided
 * by the model's context limit; the 1m-context models are detected from the model id.
 */
export function contextFracFromUsage(
  usage: Record<string, unknown>,
  model: string,
  defaultLimit: number,
): number | null {
  const used = contextUsedFromUsage(usage);
  if (used <= 0) return null;
  const limit = /\[1m\]|-1m\b|1m\b/i.test(model) ? 1_000_000 : defaultLimit;
  return Math.min(1, used / limit);
}

/** The tokens actually occupying the context window: prompt + both cache tiers. */
export function contextUsedFromUsage(usage: Record<string, unknown>): number {
  const n = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  return n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
}

/** A short, human line from an assistant/user transcript entry, for the tail log. */
function tailLineOf(obj: Record<string, unknown>): string | null {
  const message = isRecord(obj["message"]) ? obj["message"] : null;
  const text = messageText(message).trim();
  if (!text) return null;
  // First non-empty line, collapsed — the tail is a glance, not the full turn.
  const first = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return first.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Parse a transcript's timing, context fill and tail from its head+tail slices.
 * `defaultLimit` is the config context-window size; the model id (read from the tail) can
 * override it for 1m-context models.
 */
export function readTelemetry(
  headText: string,
  tailText: string,
  defaultLimit: number,
  tailCount = 4,
): {
  firstTsMs: number | null;
  lastTsMs: number | null;
  contextFrac: number | null;
  contextTokens: number | null;
  contextPeak: number | null;
  model: string;
  tail: string[];
} {
  let firstTsMs: number | null = null;
  for (const line of lastLines(headText, 200)) {
    try {
      const obj = JSON.parse(line);
      if (isRecord(obj)) {
        const ts = lineTsMs(obj);
        if (ts !== null) {
          firstTsMs = ts;
          break;
        }
      }
    } catch {
      /* skip */
    }
  }

  let lastTsMs: number | null = null;
  let contextFrac: number | null = null;
  let contextTokens: number | null = null;
  let contextPeak: number | null = null;
  let model = "";
  const tailAll: string[] = [];
  for (const line of lastLines(tailText, 200)) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const ts = lineTsMs(obj);
    if (ts !== null) lastTsMs = ts;
    const message = isRecord(obj["message"]) ? obj["message"] : null;
    if (message) {
      if (typeof message["model"] === "string" && message["model"] !== "<synthetic>") {
        model = message["model"];
      }
      const usage = isRecord(message["usage"]) ? message["usage"] : null;
      if (usage) {
        const used = contextUsedFromUsage(usage);
        if (used > 0) {
          contextTokens = used; // current fill = newest usage record
          contextPeak = contextPeak == null ? used : Math.max(contextPeak, used);
        }
        const frac = contextFracFromUsage(usage, model, defaultLimit);
        if (frac !== null) contextFrac = frac;
      }
    }
    const tl = tailLineOf(obj);
    if (tl) tailAll.push(tl);
  }

  return {
    firstTsMs,
    lastTsMs,
    contextFrac,
    contextTokens,
    contextPeak,
    model,
    tail: tailAll.slice(Math.max(0, tailAll.length - tailCount)),
  };
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
    // Trailing lines that carry no work are not evidence the agent recovered, so keep looking
    // past them. Observed in the field: an agent died on "API Error: Connection closed
    // mid-response", an interrupt was recorded after it, and that one line masked the error —
    // the agent was filed as merely "stalled" and took the slow path instead of CONN.
    if (isNonProgressLine(obj)) continue;
    // Any other parseable line IS real work after the error, so the agent recovered on its own.
    return null;
  }
  return null;
}

/**
 * A transcript line that records no progress: an interrupt, or an empty/whitespace-only
 * message. Deliberately narrow — anything richer (an assistant turn, a tool result) means the
 * agent kept working, which is exactly what must still stop the walk.
 */
export function isNonProgressLine(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const text = messageTextOf(obj as Record<string, unknown>);
  if (text === null) return false;
  const t = text.trim().toLowerCase();
  if (t.length === 0) return true;
  return t.startsWith("[request interrupted") || t === "[no content]";
}

/** The plain text of a transcript line's message, whether string or content-block array. */
function messageTextOf(obj: Record<string, unknown>): string | null {
  const message = obj["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const bt = (block as Record<string, unknown>)["text"];
      if (typeof bt === "string") parts.push(bt);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

interface RunSnapshot {
  scriptPath?: unknown;
  args?: unknown;
  workflowProgress?: unknown;
  workflowName?: unknown;
  /** Total agents the workflow planned to run — the denominator for "pending". */
  agentCount?: unknown;
}

/**
 * The workflow's own name (its script `meta.name`). Prefer the snapshot's `workflowName`;
 * for a live run with no snapshot yet, derive it from the persisted script filename, which
 * is `<name>-<runId>.js` under `<session>/workflows/scripts/`.
 */
export function deriveWorkflowName(
  sessionDir: string,
  runId: string,
  snapshot: RunSnapshot | null,
): string | null {
  if (snapshot && typeof snapshot.workflowName === "string" && snapshot.workflowName) {
    return snapshot.workflowName;
  }
  try {
    const scriptsDir = join(sessionDir, "workflows", "scripts");
    const suffix = `-${runId}.js`;
    for (const f of readdirSync(scriptsDir)) {
      if (f.endsWith(suffix)) return f.slice(0, -suffix.length);
    }
  } catch {
    /* no scripts dir yet */
  }
  // Last resort for a live run with no snapshot/script yet: recover the name from the caller
  // session's Workflow tool-call. The caller transcript can be large (tens of MB), so this is
  // cached: a positive is cached forever, and a negative is retried only a few times (a run's
  // Workflow call is logged at start, so a name that isn't there after a few scans won't appear)
  // — this stops a nameless run re-reading the whole transcript on every 12s discovery tick.
  const cacheKey = `${sessionDir}::${runId}`;
  const cached = WORKFLOW_NAME_CACHE.get(cacheKey);
  if (cached && (cached.name !== null || cached.attempts >= 3)) return cached.name;
  const fromCaller = workflowNameFromCaller(sessionDir, runId);
  WORKFLOW_NAME_CACHE.set(cacheKey, { name: fromCaller, attempts: (cached?.attempts ?? 0) + 1 });
  return fromCaller;
}

/** name-by-run cache: positives forever, negatives up to a few attempts (see deriveWorkflowName). */
const WORKFLOW_NAME_CACHE = new Map<string, { name: string | null; attempts: number }>();

/**
 * Recover a workflow's `meta.name` from the caller session transcript: find the `Workflow`
 * tool-call whose result carries this runId, and read the name from its inline script or the
 * basename of its scriptPath. Cheap despite the file size — only lines that mention `Workflow`
 * or the runId are ever JSON-parsed.
 */
export function workflowNameFromCaller(sessionDir: string, runId: string): string | null {
  let text: string;
  try {
    text = readFileSync(`${sessionDir}.jsonl`, "utf8");
  } catch {
    return null;
  }
  const nameByUseId = new Map<string, string>();
  let targetUseId: string | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (!line.includes('"Workflow"') && !line.includes(runId)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const message = isRecord(obj["message"]) ? obj["message"] : null;
    const content = message && Array.isArray(message["content"]) ? message["content"] : null;
    if (!content) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] === "tool_use" && block["name"] === "Workflow" && typeof block["id"] === "string") {
        const input = isRecord(block["input"]) ? block["input"] : {};
        const name = workflowNameFromInput(input);
        if (name) nameByUseId.set(block["id"], name);
      } else if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        if (JSON.stringify(block).includes(runId)) targetUseId = block["tool_use_id"];
      }
    }
  }
  return targetUseId ? (nameByUseId.get(targetUseId) ?? null) : null;
}

/** The workflow name declared by a `Workflow` tool-call input: inline `meta.name`, else the
 *  basename (sans extension and any trailing run id) of its scriptPath. */
function workflowNameFromInput(input: Record<string, unknown>): string | null {
  const script = input["script"];
  if (typeof script === "string") {
    const m = /name:\s*['"]([^'"]+)['"]/.exec(script);
    if (m && m[1]) return m[1];
  }
  const scriptPath = input["scriptPath"];
  if (typeof scriptPath === "string" && scriptPath) {
    const base = basename(scriptPath).replace(/\.[^.]+$/, "");
    const stem = base.replace(/-wf_[a-z0-9-]+$/i, "");
    return stem || null;
  }
  return null;
}

/** The workspace (repo) name from a cwd path, e.g. /Users/x/Dev/perch -> "perch". */
export function workspaceFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter((p) => p.length > 0);
  // A worktree cwd is `<repo>/.claude/worktrees/<name>`; the workspace is the repo, not the
  // worktree folder, so a fleet agent reads as its repo (dAIolog), not `wf_36168341-ea2-2`.
  const dot = parts.indexOf(".claude");
  if (dot > 0 && parts[dot + 1] === "worktrees") return parts[dot - 1] ?? null;
  return parts.at(-1) ?? null;
}

export interface ScanOptions {
  now: number;
  liveWindowMs: number;
  /** No output/context change for this long → stalled. Defaults to no stall detection. */
  stallWindowMs?: number;
  /** Model context-window size for the fill computation. Defaults to 200k. */
  contextLimitTokens?: number;
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
  const stalled: StalledAgent[] = [];
  const agents: AgentTelemetry[] = [];
  let liveAgents = 0;
  let completedAgents = 0;
  let cwd: string | null = null;
  let startedAtMs: number | null = null;
  const limit = opts.contextLimitTokens ?? 200_000;

  for (const fileName of transcripts) {
    const agentId = fileName.slice("agent-".length, -".jsonl".length);
    const key = index.keyByAgent.get(agentId) ?? null;

    const file = join(runDir, fileName);
    const tail = readSlice(file, TAIL_BYTES, "tail");
    const head = readSlice(file, HEAD_BYTES, "head");
    if (!tail) continue;
    if (!cwd) cwd = parseCwd(tail.text);

    const tele = readTelemetry(head?.text ?? tail.text, tail.text, limit);
    if (tele.firstTsMs !== null) {
      startedAtMs = startedAtMs === null ? tele.firstTsMs : Math.min(startedAtMs, tele.firstTsMs);
    }
    const quietForMs = tele.lastTsMs !== null ? Math.max(0, opts.now - tele.lastTsMs) : opts.now - tail.mtimeMs;
    const durationMs = tele.firstTsMs !== null && tele.lastTsMs !== null ? tele.lastTsMs - tele.firstTsMs : null;

    // A transcript with no `started` line has no ledger key; still surface its telemetry.
    const hasResult = key !== null && index.resultKeys.has(key);
    let kind: AgentTelemetry["kind"];

    if (hasResult) {
      completedAgents += 1;
      kind = "done";
    } else {
      const sig = apiErrorFromTail(tail.text);
      const lostNow =
        key !== null &&
        isLost({
          hasApiErrorTail: sig !== null,
          hasResult,
          mtimeMs: tail.mtimeMs,
          now: opts.now,
          liveWindowMs: opts.liveWindowMs,
        });
      if (lostNow && sig) {
        const label = labels.get(agentId) ?? null;
        const item = agentIdentity(head ? head.text : null, label);
        lost.push({
          key: key!,
          agentId,
          item,
          errorText: sig.errorText,
          classification: classify({ status: sig.status, message: sig.errorText }),
          transcriptFile: file,
          mtimeMs: tail.mtimeMs,
        });
        kind = "lost";
      } else if (
        key !== null &&
        opts.stallWindowMs !== undefined &&
        sig === null &&
        quietForMs > opts.stallWindowMs
      ) {
        // Alive (no error tail, not yet past the live window as a loss) but silent past the
        // stall window: nothing new written and, by the last usage record, no context change.
        const label = labels.get(agentId) ?? null;
        const item = agentIdentity(head ? head.text : null, label);
        stalled.push({ key, agentId, item, quietForMs, transcriptFile: file, mtimeMs: tail.mtimeMs });
        kind = "stalled";
      } else {
        liveAgents += 1;
        kind = "live";
      }
    }

    const label2 = labels.get(agentId) ?? null;
    agents.push({
      agentId,
      key,
      item: agentIdentity(head ? head.text : null, label2),
      kind,
      firstTsMs: tele.firstTsMs,
      lastTsMs: tele.lastTsMs,
      durationMs,
      contextFrac: tele.contextFrac,
      contextTokens: tele.contextTokens,
      quietForMs: kind === "stalled" ? quietForMs : null,
      tail: tele.tail,
    });
  }

  // Run-level context window: if any agent's context ever exceeded the default (200k), the run
  // is on a 1m-context model, so re-scale every agent's fill against 1m. This is what stops a
  // 197k-token agent on a 1m model from reading as 98% full. We only ever UP-scale (a model-tag
  // already resolved to 1m in readTelemetry is never pulled back down).
  const peak = agents.reduce((m, a) => Math.max(m, a.contextTokens ?? 0), 0);
  if (peak > limit) {
    for (const a of agents) {
      if (a.contextTokens != null) a.contextFrac = Math.min(1, a.contextTokens / LARGE_CONTEXT_LIMIT);
    }
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
    stalled,
    agents,
    startedAtMs,
    callerTail: readCallerTail(parts.sessionDir, 2),
    workflowName: deriveWorkflowName(parts.sessionDir, parts.runId, snapshot),
    workspace: workspaceFromCwd(cwd),
    plannedCount:
      snapshot && typeof snapshot.agentCount === "number" && Number.isFinite(snapshot.agentCount)
        ? snapshot.agentCount
        : null,
  };
}

/**
 * The last cleaned lines of the top-level claude session that launched this run — the
 * "caller". Its transcript sits at `<project>/<sessionId>.jsonl`, sibling to the session
 * directory. Best-effort: returns [] when it can't be read.
 */
export function readCallerTail(sessionDir: string, count: number): string[] {
  const file = `${sessionDir}.jsonl`;
  const slice = readSlice(file, TAIL_BYTES, "tail");
  if (!slice) return [];
  const out: string[] = [];
  for (const line of lastLines(slice.text, 60)) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const tl = tailLineOf(obj);
    if (tl) out.push(tl);
  }
  return out.slice(Math.max(0, out.length - count));
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
