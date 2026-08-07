/**
 * Pure formatting for the `lifeline` control surface (Seam C).
 *
 * Everything here is a pure function of its arguments: no file reads, no network, no
 * writes to stdout. `index.ts` does the printing. The state vocabulary is fixed by the
 * spec (docs/feature-specs/feature-v1-resilience-core.md §C) and by the research on
 * CI state naming — in particular a per-agent failure while siblings still run reads as
 * a run-level WARNING, never an error.
 */

import { DEFAULT_POLICY } from "../shared/backoff.js";
import type { AgentState, RunState, StatusAgent, StatusRun, StatusSnapshot } from "../shared/types.js";
import type { DoctorCheck, DoctorReport } from "./commands.js";

/* ------------------------------------------------------------------ colour */

export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  grey: "\u001b[90m",
} as const;

export type AnsiCode = (typeof ANSI)[keyof typeof ANSI];

/**
 * NO_COLOR guard (no-color.org): any non-empty NO_COLOR disables colour regardless of
 * TTY. FORCE_COLOR wins the other way so piped output can still be coloured on request.
 */
export function colorEnabled(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return isTty;
}

export function paint(text: string, code: AnsiCode, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

/* ---------------------------------------------------------------- duration */

/** Coarse human duration: "12s", "2m 10s", "1h 4m". Always non-negative. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

/** "3s ago" / "in 12s" / "just now" for a timestamp relative to `now`. */
export function formatRelative(atMs: number, nowMs: number): string {
  const delta = nowMs - atMs;
  if (Math.abs(delta) < 1000) return "just now";
  return delta > 0 ? `${formatDuration(delta)} ago` : `in ${formatDuration(-delta)}`;
}

/* ------------------------------------------------------------- state text */

/**
 * The per-agent vocabulary. These strings are the contract the spec's acceptance
 * criteria are written against — change them only with the spec.
 */
export function formatAgentState(agent: StatusAgent, nowMs: number): string {
  switch (agent.state) {
    case "retrying": {
      const max = agent.maxAttempts > 0 ? agent.maxAttempts : DEFAULT_POLICY.maxAttempts;
      const head = `retrying (${agent.attempts}/${max}`;
      if (agent.nextRetryAt == null) return `${head})`;
      const remaining = agent.nextRetryAt - nowMs;
      if (remaining <= 0) return `${head}, due now)`;
      return `${head}, next in ${formatDuration(remaining)})`;
    }
    case "paused-offline":
      return "paused (offline)";
    case "paused-usage-limit":
      return "paused (usage limit)";
    case "paused-manual":
      return "paused";
    case "failed-terminal":
      return "failed";
    case "done":
      return "done";
  }
}

/** Run-level vocabulary: `completed with failures` and `warning` stay distinct from `completed`. */
export function formatRunState(state: RunState): string {
  switch (state) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "completed-with-failures":
      return "completed with failures";
    case "warning":
      return "warning";
    case "recovering":
      return "recovering";
  }
}

function agentColor(state: AgentState): AnsiCode {
  switch (state) {
    case "retrying":
      return ANSI.yellow;
    case "paused-offline":
    case "paused-usage-limit":
    case "paused-manual":
      return ANSI.blue;
    case "failed-terminal":
      return ANSI.red;
    case "done":
      return ANSI.green;
  }
}

function agentGlyph(state: AgentState): string {
  switch (state) {
    case "failed-terminal":
      return "x";
    case "done":
      return "+";
    case "retrying":
    case "paused-offline":
    case "paused-usage-limit":
    case "paused-manual":
      return "*";
  }
}

/**
 * Run-level colour. `warning` and `completed-with-failures` are deliberately YELLOW,
 * not red: a sibling failure inside a live or finished run is a warning, and only a
 * whole-run failure would be an error (spec §C, forensics FINDINGS.md item 4).
 */
function runColor(state: RunState): AnsiCode {
  switch (state) {
    case "running":
      return ANSI.cyan;
    case "completed":
      return ANSI.green;
    case "completed-with-failures":
    case "warning":
    case "recovering":
      return ANSI.yellow;
  }
}

function runGlyph(state: RunState): string {
  switch (state) {
    case "completed":
      return "+";
    case "completed-with-failures":
    case "warning":
      return "!";
    case "running":
    case "recovering":
      return "*";
  }
}

/* ----------------------------------------------------------------- counts */

export interface AgentCounts {
  total: number;
  retrying: number;
  paused: number;
  failed: number;
  done: number;
}

export function countAgents(runs: readonly StatusRun[]): AgentCounts {
  const counts: AgentCounts = { total: 0, retrying: 0, paused: 0, failed: 0, done: 0 };
  for (const run of runs) {
    for (const agent of run.agents) {
      counts.total += 1;
      switch (agent.state) {
        case "retrying":
          counts.retrying += 1;
          break;
        case "paused-offline":
        case "paused-usage-limit":
        case "paused-manual":
          counts.paused += 1;
          break;
        case "failed-terminal":
          counts.failed += 1;
          break;
        case "done":
          counts.done += 1;
          break;
      }
    }
  }
  return counts;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The label used for an agent in the left column, and as the `runId/<agentId>` handle. */
export function agentLabel(agent: StatusAgent): string {
  return agent.item ?? agent.agentId ?? "(unnamed)";
}

/* ------------------------------------------------------------ renderStatus */

export interface RenderOptions {
  /** Force colour on/off. Defaults to the NO_COLOR / TTY guard. */
  color?: boolean;
  /** Clock, injectable so countdowns are deterministic. */
  now?: number;
  /** Snapshot older than this is flagged stale (the daemon may be down). */
  staleAfterMs?: number;
}

/** Format a StatusSnapshot into a terminal block. Pure: returns the string, prints nothing. */
export function renderStatus(snapshot: StatusSnapshot | null, opts: RenderOptions = {}): string {
  const color = opts.color ?? colorEnabled(process.env, process.stdout.isTTY === true);
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? 60_000;
  const lines: string[] = [];

  if (snapshot == null) {
    lines.push(paint("lifeline", ANSI.bold, color) + "  " + paint("no status yet", ANSI.grey, color));
    lines.push(paint("  The daemon has not written ~/.lifeline/status.json. Run `lifeline doctor`.", ANSI.dim, color));
    return lines.join("\n");
  }

  const connectivity = snapshot.online
    ? paint("online", ANSI.green, color)
    : paint("offline", ANSI.yellow, color);
  const age = now - snapshot.updatedAt;
  const stale = age > staleAfterMs;
  const updated = `updated ${formatRelative(snapshot.updatedAt, now)}${stale ? " (stale)" : ""}`;
  lines.push(
    `${paint("lifeline", ANSI.bold, color)}  ${connectivity} ${paint("·", ANSI.grey, color)} ${paint(
      updated,
      stale ? ANSI.yellow : ANSI.grey,
      color,
    )}`,
  );

  if (snapshot.runs.length === 0) {
    lines.push("");
    lines.push(paint("  No runs tracked.", ANSI.grey, color));
    return lines.join("\n");
  }

  // Pad on the uncoloured text so alignment survives the ANSI escapes: pad first, paint
  // after, and trim the line end so an unpadded last column leaves no trailing space.
  let labelWidth = 0;
  let stateWidth = 0;
  for (const run of snapshot.runs) {
    for (const agent of run.agents) {
      labelWidth = Math.max(labelWidth, agentLabel(agent).length);
      stateWidth = Math.max(stateWidth, formatAgentState(agent, now).length);
    }
  }

  for (const run of snapshot.runs) {
    lines.push("");
    lines.push(
      [
        paint(runGlyph(run.state), runColor(run.state), color),
        paint(run.runId, ANSI.bold, color),
        paint(run.project, ANSI.grey, color),
        paint(formatRunState(run.state), runColor(run.state), color),
      ].join("  "),
    );

    if (run.agents.length === 0) {
      lines.push(paint("    (no agents tracked)", ANSI.grey, color));
      continue;
    }

    for (const agent of run.agents) {
      const label = agentLabel(agent).padEnd(labelWidth);
      const stateText = formatAgentState(agent, now);
      const statePad = " ".repeat(Math.max(0, stateWidth - stateText.length));
      const trailing: string[] = [];
      if (agent.lastClass != null) trailing.push(agent.lastClass);
      // Show the id alongside a human item so `lifeline retry <runId>/<agentId>` is typeable.
      if (agent.agentId != null && agent.item != null) trailing.push(`[${agent.agentId}]`);
      const tail = trailing.length > 0 ? "  " + paint(trailing.join(" "), ANSI.grey, color) : "";
      const line =
        `    ${paint(agentGlyph(agent.state), agentColor(agent.state), color)} ${label}  ` +
        paint(stateText, agentColor(agent.state), color) +
        statePad +
        tail;
      lines.push(line.trimEnd());
    }
  }

  const counts = countAgents(snapshot.runs);
  const parts = [plural(snapshot.runs.length, "run"), plural(counts.total, "agent")];
  if (counts.retrying > 0) parts.push(`${counts.retrying} retrying`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  lines.push("");
  lines.push(paint(parts.join(" · "), ANSI.grey, color));

  return lines.join("\n");
}

/* ------------------------------------------------------------ renderDoctor */

function checkColor(level: DoctorCheck["level"]): AnsiCode {
  switch (level) {
    case "ok":
      return ANSI.green;
    case "warn":
      return ANSI.yellow;
    case "fail":
      return ANSI.red;
  }
}

function checkTag(level: DoctorCheck["level"]): string {
  switch (level) {
    case "ok":
      return "ok  ";
    case "warn":
      return "warn";
    case "fail":
      return "fail";
  }
}

/** Format a doctor report. Pure, same contract as renderStatus. */
export function renderDoctor(report: DoctorReport, opts: RenderOptions = {}): string {
  const color = opts.color ?? colorEnabled(process.env, process.stdout.isTTY === true);
  const lines: string[] = [paint("lifeline doctor", ANSI.bold, color), ""];

  const labelWidth = report.checks.reduce((w, c) => Math.max(w, c.label.length), 0);
  for (const check of report.checks) {
    lines.push(
      `  ${paint(checkTag(check.level), checkColor(check.level), color)}  ` +
        `${check.label.padEnd(labelWidth)}  ${paint(check.detail, ANSI.grey, color)}`,
    );
  }

  lines.push("");
  if (report.hardFailure) {
    lines.push(paint("Not healthy — fix the failing checks above.", ANSI.red, color));
  } else if (!report.ok) {
    lines.push(paint("Healthy, with warnings.", ANSI.yellow, color));
  } else {
    lines.push(paint("All green.", ANSI.green, color));
  }
  return lines.join("\n");
}
