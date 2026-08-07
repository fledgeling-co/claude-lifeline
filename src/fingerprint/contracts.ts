/**
 * Contract probes — the observable facts about an installed Claude Code whose SHAPE
 * lifeline depends on (PLAN.md §"Install / update seam"; FINDINGS.md §"CORRECTED ARCHITECTURE").
 *
 * We never fingerprint the binary's bytes: it is a 265MB Bun bytecode build whose offsets move
 * every release, so a byte hash drifts on every update and tells us nothing. We fingerprint the
 * three CONTRACTS the daemon actually reads against, so an update only trips the flag when
 * something we depend on genuinely moved.
 *
 * Each probe is pure: `normalize(input) -> string`. The caller gathers the inputs (I/O lives in
 * index.ts) and index.ts hashes the normalized string. Normalization is deliberately tolerant of
 * ADDITIVE change (a new journal key, a new entry type) and intolerant of REMOVAL — additive
 * change does not break a reader, removal does.
 */

export type ProbeName = "journal-line-shape" | "disk-layout" | "workflow-tool-anchors";

export const PROBE_NAMES: readonly ProbeName[] = [
  "journal-line-shape",
  "disk-layout",
  "workflow-tool-anchors",
];

/** Journal entry types the daemon parses. Kept sorted — the order is part of the probe value. */
export const JOURNAL_CONTRACT_TYPES: readonly string[] = ["result", "started"];

/** UTF-8 atoms the recovery path depends on surviving in the installed binary. Kept sorted. */
export const WORKFLOW_MARKERS: readonly string[] = [
  "journal.jsonl",
  "resumeFromRunId",
  "workflow_agent",
];

/** The layout segment we anchor a journal path against. */
const LAYOUT_ANCHOR = "subagents";

const ABSENT = "<absent>";
const NONE_OBSERVED = "<none-observed>";
const UNRECOGNIZED = "<unrecognized>";

/** Bound the disk-layout value so a moved layout cannot produce an unbounded string. */
const MAX_DISTINCT_TEMPLATES = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Probe inputs ────────────────────────────────────────────────────────────────────────────

export interface JournalLineShapeInput {
  /** Parsed journal.jsonl entries sampled from real runs. */
  entries: readonly Record<string, unknown>[];
}

export interface DiskLayoutInput {
  /** Absolute paths of discovered journal.jsonl files. */
  journalPaths: readonly string[];
}

export interface WorkflowAnchorsInput {
  /**
   * Marker -> present. Supplied by the caller (index.ts streams the binary in chunks); a marker
   * missing from this map reads as absent, so an unreadable binary fails closed.
   */
  markers: Readonly<Record<string, boolean>>;
}

/** The input each probe consumes, keyed by probe name. */
export interface ProbeInputs {
  "journal-line-shape": JournalLineShapeInput;
  "disk-layout": DiskLayoutInput;
  "workflow-tool-anchors": WorkflowAnchorsInput;
}

export interface ContractProbe<K extends ProbeName> {
  readonly name: K;
  /** One line, shown in `lifeline doctor` and in the incompatibility flag. */
  describe(): string;
  /** Pure: same input -> same string. The string is what gets hashed. */
  normalize(input: ProbeInputs[K]): string;
}

// ── journal-line-shape ──────────────────────────────────────────────────────────────────────

/**
 * The top-level keys ALWAYS present on each contract entry type, as an intersection across the
 * sample. Intersection (not union) is the fail-closed reading: a key that vanishes from some
 * entries is no longer something a reader can rely on, while a newly added optional key — which
 * a union would surface as drift — breaks nothing.
 */
export const journalLineShapeProbe: ContractProbe<"journal-line-shape"> = {
  name: "journal-line-shape",
  describe: () =>
    `top-level keys always present on journal.jsonl ${JOURNAL_CONTRACT_TYPES.join("/")} entries`,
  normalize(input) {
    const always = new Map<string, string[]>();
    for (const entry of input.entries) {
      const rawType = entry["type"];
      if (typeof rawType !== "string" || !JOURNAL_CONTRACT_TYPES.includes(rawType)) continue;
      const keys = Object.keys(entry).sort();
      const seen = always.get(rawType);
      always.set(rawType, seen === undefined ? keys : seen.filter((k) => keys.includes(k)));
    }
    return JOURNAL_CONTRACT_TYPES.map((type) => {
      const keys = always.get(type);
      return `${type}=${keys && keys.length > 0 ? keys.join(",") : ABSENT}`;
    }).join(" ");
  },
};

// ── disk-layout ─────────────────────────────────────────────────────────────────────────────

function generalizeSegment(segment: string): string {
  if (segment.startsWith("wf_")) return "wf_*";
  if (/^agent-.+\.jsonl$/.test(segment)) return "agent-*.jsonl";
  if (UUID_RE.test(segment)) return "<uuid>";
  return segment;
}

/**
 * Reduce an absolute journal path to the template we depend on:
 * `subagents/workflows/wf_*<slash>journal.jsonl`. Everything above the anchor is the user's project
 * and session and is not part of the contract.
 */
export function generalizeJournalPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  const anchor = segments.lastIndexOf(LAYOUT_ANCHOR);
  const tail = anchor >= 0 ? segments.slice(anchor) : segments.slice(-3);
  const shaped = tail.map(generalizeSegment).join("/");
  return anchor >= 0 ? shaped : `${UNRECOGNIZED}/${shaped}`;
}

export const diskLayoutProbe: ContractProbe<"disk-layout"> = {
  name: "disk-layout",
  describe: () => `workflow journal path template (${LAYOUT_ANCHOR}/workflows/wf_*/journal.jsonl)`,
  normalize(input) {
    const templates = new Set<string>();
    for (const path of input.journalPaths) templates.add(generalizeJournalPath(path));
    if (templates.size === 0) return NONE_OBSERVED;
    const sorted = [...templates].sort();
    const shown = sorted.slice(0, MAX_DISTINCT_TEMPLATES);
    const overflow = sorted.length - shown.length;
    return overflow > 0 ? `${shown.join(" | ")} | +${overflow}` : shown.join(" | ");
  },
};

// ── workflow-tool-anchors ───────────────────────────────────────────────────────────────────

export const workflowAnchorsProbe: ContractProbe<"workflow-tool-anchors"> = {
  name: "workflow-tool-anchors",
  describe: () => `presence of workflow atoms in the installed binary (${WORKFLOW_MARKERS.join(", ")})`,
  normalize(input) {
    // Iterate the canonical list, not the caller's keys, so an extra key cannot shift the value.
    return WORKFLOW_MARKERS.map(
      (marker) => `${marker}=${input.markers[marker] === true ? "present" : "absent"}`,
    ).join(" ");
  },
};

// ── registry ────────────────────────────────────────────────────────────────────────────────

export const CONTRACT_PROBES: { [K in ProbeName]: ContractProbe<K> } = {
  "journal-line-shape": journalLineShapeProbe,
  "disk-layout": diskLayoutProbe,
  "workflow-tool-anchors": workflowAnchorsProbe,
};

/**
 * Dispatch one probe over the input bundle. Generic in K so the probe and its input stay
 * correlated — a non-generic loop would widen both sides to a union and stop typechecking.
 */
export function runProbe<K extends ProbeName>(name: K, inputs: ProbeInputs): string {
  return CONTRACT_PROBES[name].normalize(inputs[name]);
}
