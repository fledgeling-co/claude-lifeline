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
}

export const DEFAULT_CONFIG: LifelineConfig = {
  gatewayHost: "127.0.0.1",
  gatewayPort: 8787,
  upstream: process.env.LIFELINE_UPSTREAM ?? "https://api.anthropic.com",
  requestBudgetMs: 90_000,
  gatewayMaxAttempts: 8,
  recovery: DEFAULT_POLICY,
  daemonTickMs: 5_000,
  probeUrl: "https://api.anthropic.com/v1/",
  liveWindowMs: 300_000,
  stallWindowMs: 600_000, // 10 minutes of no output/context change
  contextLimitTokens: 200_000,
  discoverWindowMs: 3 * 60 * 60_000, // show workflow runs active in the last 3 hours
  discoverIntervalMs: 12_000, // full-tree discovery walk cadence
  retentionMs: 3 * 60 * 60_000, // keep a run visible as long as it's within the window
  completedRetentionMs: 60 * 60_000, // show a finished run, greyed, for an hour after it ends
  maxRunsShown: 30, // cap the list to the most recent runs
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
  };
  // Env overrides win over the file (installer sets these).
  if (process.env.LIFELINE_GATEWAY_PORT) cached.gatewayPort = Number(process.env.LIFELINE_GATEWAY_PORT);
  if (process.env.LIFELINE_UPSTREAM) cached.upstream = process.env.LIFELINE_UPSTREAM;
  return cached;
}

export function gatewayUrl(cfg: LifelineConfig = loadConfig()): string {
  return `http://${cfg.gatewayHost}:${cfg.gatewayPort}`;
}
