/**
 * Plain-language run summaries.
 *
 * The status window can say how many agents are running and how full their context windows are,
 * but not what the run is actually DOING — so answering "which of these needs me?" means opening
 * rows and reading transcript tails. This asks a small model to read the tails lifeline already
 * has and return one title and one state line.
 *
 * Three properties matter more than the summary itself:
 *
 * - **It never spends twice for the same thing.** The cache key is a hash of the exact text sent.
 *   An agent that is thinking, not writing, produces the same hash and costs nothing.
 * - **It never blocks recovery.** Every call is bounded by a timeout and its failure is swallowed;
 *   the previous summary stands. A run must never look worse because describing it failed.
 * - **It sends only a capped recent tail.** Bounding cost and bounding what leaves the machine
 *   happen to be the same lever.
 *
 * Purity: `buildInput`, `inputHash`, `renderPrompt` and `parseSummary` are pure. Everything that
 * spends money or touches disk sits behind `SummariseDeps` so the whole path runs from fixtures.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";

import { readJson, writeJsonAtomic } from "../shared/io.js";
import { makeLogger } from "../shared/logger.js";
import { paths } from "../shared/paths.js";
import type { SummaryConfig } from "../shared/config.js";

const log = makeLogger("summariser");

/** The states a run can be described as. Deliberately few — this drives a one-line label. */
export const SUMMARY_STATES = ["working", "waiting", "blocked", "almost-done", "done"] as const;
export type SummaryState = (typeof SUMMARY_STATES)[number];

export interface RunSummary {
  /** A short human title for the run, e.g. "Portal contract sweep". */
  title: string;
  state: SummaryState;
  /** One short line, e.g. "waiting on 3 tasks". */
  stateLine: string;
  /** agentId -> what that agent is working on, one short phrase. */
  agentActivity: Record<string, string>;
}

export interface CachedSummary {
  hash: string;
  result: RunSummary;
  at: number;
}

/** One agent's recent output, as the daemon already parsed it. */
export interface AgentInput {
  agentId: string;
  item: string | null;
  state: string;
  tail: readonly string[];
}

export interface SummaryInput {
  runId: string;
  workflowName: string | null;
  workspace: string | null;
  agents: AgentInput[];
}

// ── Pure core ───────────────────────────────────────────────────────────────────────────────

/**
 * Trim a run down to what is worth sending: the newest `maxMessages` lines per agent, the whole
 * thing capped at `maxInputChars`. Oldest agents lose their text first — a run with forty agents
 * should still describe the ones that just moved rather than truncating mid-sentence at agent
 * three.
 */
export function buildInput(input: SummaryInput, cfg: SummaryConfig): SummaryInput {
  const agents = input.agents.map((a) => ({
    ...a,
    tail: a.tail.slice(-cfg.maxMessages).map((l) => l.trim()).filter((l) => l.length > 0),
  }));

  let budget = cfg.maxInputChars;
  const kept: AgentInput[] = [];
  // Reverse order: the agents at the end of the list are the ones that changed most recently.
  for (const agent of [...agents].reverse()) {
    const lines: string[] = [];
    for (const line of [...agent.tail].reverse()) {
      if (budget - line.length < 0) break;
      budget -= line.length;
      lines.unshift(line);
    }
    kept.unshift({ ...agent, tail: lines });
    if (budget <= 0) break;
  }
  return { ...input, agents: kept };
}

/**
 * The cache key. Covers exactly the bytes that reach the model, so any change that would change
 * the answer changes the key, and nothing else does. Agent STATE is included deliberately: an
 * agent going from running to failed writes no new tail line but does change the summary.
 */
export function inputHash(input: SummaryInput): string {
  const canonical = JSON.stringify({
    workflowName: input.workflowName,
    workspace: input.workspace,
    agents: input.agents.map((a) => ({ id: a.agentId, item: a.item, state: a.state, tail: a.tail })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Pure. The prompt, including the schema the reply must satisfy. */
export function renderPrompt(input: SummaryInput): string {
  const agents = input.agents
    .map((a) => {
      const head = `- agent ${a.agentId}${a.item ? ` (${a.item})` : ""} [${a.state}]`;
      const tail = a.tail.length > 0 ? a.tail.map((l) => `    ${l}`).join("\n") : "    (no output yet)";
      return `${head}\n${tail}`;
    })
    .join("\n");

  return [
    "You are labelling a running batch of AI coding agents for a status window. Be literal and specific: this is read at a glance, so a vague label is worse than none.",
    "",
    `Workflow: ${input.workflowName ?? "(unnamed)"}${input.workspace ? ` in ${input.workspace}` : ""}`,
    "Agents and their most recent output:",
    agents,
    "",
    "Reply with ONLY a JSON object, no prose and no code fence:",
    '{"title": string, "state": "working"|"waiting"|"blocked"|"almost-done"|"done", "stateLine": string, "agentActivity": {"<agentId>": string}}',
    "",
    "title: at most 6 words naming what this run is doing, e.g. \"Portal contract sweep\". No ids, no agent counts.",
    "stateLine: at most 8 words on where it is overall, e.g. \"waiting on 3 tasks\" or \"almost done, 1 failing\".",
    "agentActivity: one short phrase per agent id above, e.g. \"rewriting the auth tests\". Use the ids exactly as given.",
  ].join("\n");
}

/**
 * Parse a model reply into a summary, or null. Tolerant of a code fence and of surrounding prose,
 * because a small model will occasionally add both; intolerant of anything it cannot use, since a
 * wrong label shown confidently is worse than no label.
 */
export function parseSummary(raw: string, knownAgentIds: readonly string[]): RunSummary | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  const title = typeof o["title"] === "string" ? o["title"].trim() : "";
  const stateLine = typeof o["stateLine"] === "string" ? o["stateLine"].trim() : "";
  const state = SUMMARY_STATES.find((s) => s === o["state"]);
  if (title.length === 0 || stateLine.length === 0 || state === undefined) return null;

  // Only ids we asked about: a hallucinated agent id would render as a row that does not exist.
  const activity: Record<string, string> = {};
  const rawActivity = o["agentActivity"];
  if (typeof rawActivity === "object" && rawActivity !== null) {
    for (const [id, value] of Object.entries(rawActivity as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0 && knownAgentIds.includes(id)) {
        activity[id] = value.trim();
      }
    }
  }
  return { title, state, stateLine, agentActivity: activity };
}

// ── Cache ───────────────────────────────────────────────────────────────────────────────────

export function summaryFile(runId: string): string {
  return join(paths.home(), "summaries", `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function loadSummary(runId: string): CachedSummary | null {
  const v = readJson<CachedSummary | null>(summaryFile(runId), null);
  return v && typeof v.hash === "string" && v.result ? v : null;
}

export function saveSummary(runId: string, entry: CachedSummary): void {
  writeJsonAtomic(summaryFile(runId), entry);
}

/**
 * Pure. Whether a call is warranted: content changed, and the last call was long enough ago.
 * The interval floor is a second brake on top of the hash, for a run whose tail churns every
 * tick without meaning anything different.
 */
export function shouldSummarise(
  cached: CachedSummary | null,
  hash: string,
  now: number,
  cfg: SummaryConfig,
): boolean {
  if (!cfg.enabled) return false;
  if (cached === null) return true;
  if (cached.hash === hash) return false;
  return now - cached.at >= cfg.minIntervalMs;
}

// ── The call ────────────────────────────────────────────────────────────────────────────────

export type RunModel = (prompt: string, cfg: SummaryConfig) => Promise<string>;

export interface SummariseDeps {
  runModel?: RunModel;
  now?: () => number;
  load?: (runId: string) => CachedSummary | null;
  save?: (runId: string, entry: CachedSummary) => void;
}

/**
 * Ask the Claude CLI, in headless mode, for one reply. The CLI is used rather than a raw API key
 * on purpose: it is already installed and already authenticated, so summaries need no new secret
 * and inherit whatever routing (and retries) the user's setup already has.
 *
 * `claude` here is the launcher on PATH, which is lifeline's own wrapper — so this call is routed
 * through the gateway like everything else. It cannot recurse into workflow discovery: a `-p` call
 * creates no `subagents/workflows/wf_*` directory, which is the only thing the scan looks for.
 */
export const defaultRunModel: RunModel = (prompt, cfg) =>
  new Promise((resolve, reject) => {
    execFile(
      "claude",
      ["-p", prompt, "--model", cfg.model],
      { timeout: cfg.timeoutMs, maxBuffer: 1 << 20, killSignal: "SIGKILL" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/**
 * Produce a summary for one run, using the cache. Returns the summary to display (which may be
 * the cached one) or null when there is nothing to show. Never throws and never rejects: a failed
 * or slow call leaves the previous summary in place and is logged once.
 */
export async function summariseRun(
  input: SummaryInput,
  cfg: SummaryConfig,
  deps: SummariseDeps = {},
): Promise<RunSummary | null> {
  const now = deps.now ?? Date.now;
  const load = deps.load ?? loadSummary;
  const save = deps.save ?? saveSummary;
  const runModel = deps.runModel ?? defaultRunModel;

  const cached = load(input.runId);
  if (!cfg.enabled) return cached?.result ?? null;

  const trimmed = buildInput(input, cfg);
  const hash = inputHash(trimmed);
  if (!shouldSummarise(cached, hash, now(), cfg)) return cached?.result ?? null;

  try {
    const raw = await runModel(renderPrompt(trimmed), cfg);
    const result = parseSummary(raw, trimmed.agents.map((a) => a.agentId));
    if (result === null) {
      log.warn(`summary for ${input.runId} was not usable JSON; keeping the previous one`);
      return cached?.result ?? null;
    }
    save(input.runId, { hash, result, at: now() });
    return result;
  } catch (err) {
    log.warn(`summary for ${input.runId} failed`, String(err));
    return cached?.result ?? null;
  }
}
