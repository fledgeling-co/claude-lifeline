import { readFileSync } from "node:fs";
import { paths } from "./paths.js";
import type { BackoffPolicy } from "./backoff.js";
import { DEFAULT_POLICY } from "./backoff.js";

export interface LifelineConfig {
  /** Gateway listen host/port. */
  gatewayHost: string;
  gatewayPort: number;
  /** Upstream the gateway forwards to (the real API, or the user's multi-account proxy). */
  upstream: string;
  /**
   * Present only after the gateway positively identified its upstream as Relay. It makes a
   * Relay port move self-healing without ever redirecting an arbitrary localhost proxy.
   */
  relayBridge?: { lastKnownPort: number } | null;
  /** Per-request wall-clock budget for in-gateway retries, ms. Keeps under the SDK timeout. */
  requestBudgetMs: number;
  /**
   * How long the gateway may hold a request against a *holdable* park — a multi-account pool
   * reporting no eligible member — before forwarding the error. Bounded well under the SDK
   * timeout, because the alternative is the agent dying on a condition that often clears in
   * seconds. Never applied to a single account's own session limit, which resets in hours.
   * Set to 0 to forward every park immediately, which was the behaviour before pool
   * exhaustion was distinguished from an account's own limit.
   */
  parkHoldMs: number;
  /** Max retry attempts the gateway itself makes within one request. */
  gatewayMaxAttempts: number;
  /** The agent-level recovery policy the daemon uses (cap 30 etc). */
  recovery: BackoffPolicy;
  /** How often the daemon re-evaluates the ledger, ms. */
  daemonTickMs: number;
  /** Connectivity probe endpoint (expects a fast 2xx/204). */
  probeUrl: string;
  /** How long after a stalled transcript an agent is considered "not live", ms. */
  liveWindowMs: number;
  /** No new output AND no context change for this long → the agent is stalled. */
  stallWindowMs: number;
  /**
   * How long an agent must stay stalled before a recovery nudge is SCHEDULED. Deliberately
   * longer than `stallWindowMs`: that window decides when to SHOW an agent as stalled, which
   * wants to be prompt, while this one decides when to act on it, which wants to be sure.
   * Silence under this threshold is displayed and left alone.
   */
  stallGraceMs: number;
  /** The model context-window size, tokens, used to compute context-window fill. */
  contextLimitTokens: number;
  /** A run is "recently active" (and shown) if its transcripts changed within this window. */
  discoverWindowMs: number;
  /** How often the full run-discovery walk runs (heavier than a tick, so less often). */
  discoverIntervalMs: number;
  /** Keep showing a finished run this long after its last activity, then drop it. */
  retentionMs: number;
  /** A completed run stays in the list, greyed at the bottom, only this long after finishing. */
  completedRetentionMs: number;
  /** Most recent runs to show (by last activity); older ones are omitted. */
  maxRunsShown: number;
  /** Plain-language run summaries, written by a small model. Off until asked for. */
  summaries: SummaryConfig;
}

/**
 * Summaries turn a run's mechanical state (counts, meters, an opaque id) into a sentence.
 * Every call costs money, so the defaults are conservative and `enabled` starts false: nobody
 * who installs lifeline should discover it spending on their behalf.
 */
export interface SummaryConfig {
  enabled: boolean;
  /** Small and cheap by design; this is a one-line summary, not analysis. */
  model: string;
  /** Newest transcript lines per agent to send. */
  maxMessages: number;
  /** Ignore anything older than this, so a long-idle run is not re-described from stale text. */
  windowMs: number;
  /** Floor between calls for one run, on top of the content hash. */
  minIntervalMs: number;
  /** Hard ceiling on prompt size, after trimming. */
  maxInputChars: number;
  /** Give up on a call after this; a summary is never worth blocking a tick for. */
  timeoutMs: number;
}

export const DEFAULT_CONFIG: LifelineConfig = {
  gatewayHost: "127.0.0.1",
  gatewayPort: 8787,
  upstream: process.env.LIFELINE_UPSTREAM ?? "https://api.anthropic.com",
  requestBudgetMs: 90_000,
  parkHoldMs: 60_000,
  gatewayMaxAttempts: 8,
  recovery: DEFAULT_POLICY,
  daemonTickMs: 5_000,
  probeUrl: "https://api.anthropic.com/v1/",
  liveWindowMs: 300_000,
  stallWindowMs: 600_000, // 10 minutes of no output/context change
  stallGraceMs: 1_800_000, // ...but 30 minutes of it before we nudge the run
  contextLimitTokens: 200_000,
  discoverWindowMs: 3 * 60 * 60_000, // show workflow runs active in the last 3 hours
  discoverIntervalMs: 12_000, // full-tree discovery walk cadence
  retentionMs: 3 * 60 * 60_000, // keep a run visible as long as it's within the window
  completedRetentionMs: 60 * 60_000, // show a finished run, greyed, for an hour after it ends
  maxRunsShown: 30, // cap the list to the most recent runs
  summaries: {
    enabled: false, // opt-in: this is the only feature that spends money
    model: "claude-haiku-4-5-20251001",
    maxMessages: 12,
    windowMs: 30 * 60_000,
    minIntervalMs: 30_000,
    maxInputChars: 6_000,
    timeoutMs: 45_000,
  },
};

let cached: LifelineConfig | null = null;

export function loadConfig(force = false): LifelineConfig {
  if (cached && !force) return cached;
  let fromDisk: Partial<LifelineConfig> = {};
  try {
    fromDisk = JSON.parse(readFileSync(paths.config(), "utf8")) as Partial<LifelineConfig>;
  } catch {
    // No config file yet — defaults are fine.
  }
  cached = {
    ...DEFAULT_CONFIG,
    ...fromDisk,
    recovery: { ...DEFAULT_CONFIG.recovery, ...(fromDisk.recovery ?? {}) },
    summaries: { ...DEFAULT_CONFIG.summaries, ...(fromDisk.summaries ?? {}) },
  };
  // Env overrides win over the file (installer sets these).
  if (process.env.LIFELINE_GATEWAY_PORT) cached.gatewayPort = Number(process.env.LIFELINE_GATEWAY_PORT);
  if (process.env.LIFELINE_UPSTREAM) cached.upstream = process.env.LIFELINE_UPSTREAM;
  return cached;
}

export function gatewayUrl(cfg: LifelineConfig = loadConfig()): string {
  return `http://${cfg.gatewayHost}:${cfg.gatewayPort}`;
}
