/**
 * Seam A — `lifeline-gw`, the transport retry gateway.
 *
 * A transparent reverse proxy that Claude Code points at via ANTHROPIC_BASE_URL. It
 * forwards everything upstream untouched and streams SSE straight back; the only thing it
 * adds is a bounded, class-aware retry of failures the transport can heal on its own
 * (429/529, 5xx/overloaded, socket errors) before the client ever sees them.
 *
 * Two invariants shape the whole file:
 *  1. **Commit-once.** Retry is only legal while zero response bytes have reached the
 *     client. Status + headers are read first, the retry-or-commit decision is made, and
 *     only then does the body start flowing. After that the stream is committed: a
 *     mid-flight cut is a CONN truncation for the daemon to recover, not a retry.
 *  2. **Never synthesize.** A terminal class (CONTEXT/AUTH) or an exhausted schedule
 *     forwards the upstream response through byte-for-byte. The only manufactured
 *     response in this file is for a transport error where no upstream response exists.
 *
 * Long recovery (usage limits, 30 attempts over an hour) deliberately does NOT live here —
 * holding the client socket that long would trip the CLI's own SDK timeout. Those are
 * forwarded through so Seam B (the daemon) owns them.
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from "node:http";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { request } from "undici";
import type { Dispatcher } from "undici";

import { nextDelay, sleep } from "../shared/backoff.js";
import type { BackoffPolicy } from "../shared/backoff.js";
import { classify, parseRetryAfter } from "../shared/classifier.js";
import type { Classification } from "../shared/classifier.js";
import { loadConfig } from "../shared/config.js";
import type { LifelineConfig } from "../shared/config.js";
import { readJson, writeJsonAtomic } from "../shared/io.js";
import { makeLogger } from "../shared/logger.js";
import { paths } from "../shared/paths.js";
import type { ConnectivityEvent } from "../shared/types.js";

type Logger = ReturnType<typeof makeLogger>;

/** How long a connectivity probe may take before it counts as a failure. */
export const PROBE_TIMEOUT_MS = 5_000;
/** How often the offline poller re-probes while the network is down. */
export const CONNECTIVITY_POLL_MS = 30_000;

/**
 * RFC 9110 hop-by-hop headers plus the non-standard `proxy-connection`. These describe the
 * single TCP hop they arrived on and must never be relayed to the next one.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** First value of a possibly-repeated header, lowercased key assumed (node lowercases). */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Tokens listed in a `Connection:` header are themselves hop-by-hop and must be dropped. */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const out = new Set<string>();
  const raw = headers["connection"];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  if (!joined) return out;
  for (const token of joined.split(",")) {
    const t = token.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

/**
 * Headers to send upstream: the client's own, minus hop-by-hop, with `host` repointed at
 * the upstream authority. `content-length` is dropped because the body is replayed from a
 * buffer and undici recomputes it — a stale value would desync a retried request.
 */
export function buildForwardHeaders(
  incomingHeaders: IncomingHttpHeaders,
  upstreamHost: string,
): IncomingHttpHeaders {
  const drop = connectionTokens(incomingHeaders);
  const out: IncomingHttpHeaders = {};
  for (const [rawKey, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key) || drop.has(key)) continue;
    if (key === "host" || key === "content-length") continue;
    out[key] = value;
  }
  out["host"] = upstreamHost;
  return out;
}

/** Upstream response headers to relay downstream, minus hop-by-hop (node re-frames those). */
export function buildResponseHeaders(upstreamHeaders: IncomingHttpHeaders): OutgoingHttpHeaders {
  const drop = connectionTokens(upstreamHeaders);
  const out: OutgoingHttpHeaders = {};
  for (const [rawKey, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key) || drop.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Join the configured upstream (which may carry a path prefix, e.g. a user's multi-account
 * proxy at `https://proxy.local/anthropic`) with the incoming request-target.
 *
 * Leading slashes on the request-target are collapsed first: `new URL("//evil.com", origin)`
 * is protocol-relative and would silently retarget the proxy at another host.
 */
export function buildUpstreamUrl(upstream: string, requestUrl: string): string {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/+$/, "");
  const rest = requestUrl.replace(/^\/+/, "");
  return new URL(`${prefix}/${rest}`, base.origin).toString();
}

/** A Relay bridge is intentionally narrower than "any local URL". */
function loopbackPort(urlText: string): number | null {
  try {
    const url = new URL(urlText);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/** Add the marker only when the configured upstream equals Relay's currently persisted port. */
export function adoptRelayBridge(cfg: LifelineConfig, relayPort: number | null): LifelineConfig | null {
  if (cfg.relayBridge || relayPort === null || loopbackPort(cfg.upstream) !== relayPort) return null;
  return { ...cfg, relayBridge: { lastKnownPort: relayPort } };
}

/**
 * Return a repaired Relay route only for an existing, positively identified Relay bridge.
 * A stale marker cannot hijack another local service: its port must still equal the configured
 * upstream before a new port is accepted.
 */
export function repairRelayBridge(cfg: LifelineConfig, relayPort: number | null): LifelineConfig | null {
  const known = cfg.relayBridge?.lastKnownPort;
  if (
    !Number.isInteger(known) ||
    known === undefined ||
    relayPort === null ||
    loopbackPort(cfg.upstream) !== known
  ) {
    return null;
  }
  if (relayPort === known) return null;
  return {
    ...cfg,
    upstream: `http://127.0.0.1:${relayPort}`,
    relayBridge: { lastKnownPort: relayPort },
  };
}

/**
 * Remove an identity marker that no longer describes the configured upstream.
 *
 * The marker is an assertion made by Lifeline itself: every successful adoption and repair writes
 * its port alongside the same upstream. A mismatch can therefore only be a legacy/config-writer
 * defect or an operator changing the upstream outside the gateway. Clearing the marker preserves
 * that chosen upstream; it deliberately does NOT redirect it to the current Relay port. A later
 * adoption still requires the exact loopback-port match below.
 */
export function discardIncoherentRelayBridge(cfg: LifelineConfig): LifelineConfig | null {
  const known = cfg.relayBridge?.lastKnownPort;
  if (!Number.isInteger(known) || known === undefined || loopbackPort(cfg.upstream) === known) return null;
  const { relayBridge: _, ...withoutMarker } = cfg;
  return withoutMarker;
}

/** Read Relay's UserDefaults value without a shell; malformed output is never trusted. */
function readRelayPort(): number | null {
  try {
    const output = execFileSync(
      "/usr/bin/defaults",
      ["read", "dev.perch.app", "RELAY_PROXY_PORT"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!/^\d+$/.test(output)) return null;
    const port = Number(output);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function persistRelayBridge(cfg: LifelineConfig): void {
  try {
    writeJsonAtomic(paths.config(), cfg);
  } catch {
    // The request can still use the repaired in-memory route. Do not fail a model turn because
    // the best-effort state write did not succeed.
  }
}

/** The gateway's per-request backoff policy: 1s base, 60s cap, attempts + budget from config. */
export function gatewayPolicy(cfg: LifelineConfig): BackoffPolicy {
  return {
    baseMs: 1000,
    capMs: 60_000,
    maxAttempts: cfg.gatewayMaxAttempts,
    maxDurationMs: cfg.requestBudgetMs,
  };
}

export interface RetryDecision {
  retry: boolean;
  /** Sleep before the retry, ms. 0 when `retry` is false. */
  delayMs: number;
  reason: string;
}

/**
 * Decide whether an attempt may be retried on the socket, given the class, the 0-based
 * retry index, the elapsed wall-clock, the policy and the per-request budget.
 */
export function shouldRetry(
  classification: Classification,
  attempt: number,
  elapsedMs: number,
  policy: BackoffPolicy,
  budgetMs: number,
  rng?: () => number,
  parkHoldMs = 0,
): RetryDecision {
  if (!classification.retryable) {
    return { retry: false, delayMs: 0, reason: `terminal:${classification.class}` };
  }
  // A park heals on the provider's clock — minutes to hours. Holding the client socket for
  // that would trip the CLI's own SDK timeout, so it is forwarded through and the daemon
  // schedules the real recovery.
  //
  // A HOLDABLE park is the exception worth making: a multi-account pool with nothing eligible
  // right now re-admits members as their reserves roll over, so the condition frequently clears
  // inside a minute. Forwarding it instantly kills the agent on something that was about to
  // succeed — which is exactly how a fan-out loses half its agents to one bad minute. Retry
  // within the hold budget; if it does not clear, forward and let the daemon park it as before.
  let effectiveBudgetMs = budgetMs;
  if (classification.park) {
    const hold = classification.holdable ? Math.min(budgetMs, Math.max(0, parkHoldMs)) : 0;
    if (hold === 0) {
      return { retry: false, delayMs: 0, reason: `park:${classification.class}` };
    }
    if (elapsedMs >= hold) {
      return { retry: false, delayMs: 0, reason: "park-hold-exhausted" };
    }
    effectiveBudgetMs = hold;
  }
  if (elapsedMs >= effectiveBudgetMs) {
    return { retry: false, delayMs: 0, reason: "budget-exhausted" };
  }

  const bounded: BackoffPolicy = {
    ...policy,
    maxDurationMs: Math.min(policy.maxDurationMs ?? effectiveBudgetMs, effectiveBudgetMs),
  };
  const next = nextDelay({
    policy: bounded,
    attempt,
    retryAfterMs: classification.retryAfterMs,
    elapsedMs,
    rng,
  });
  if (next.delayMs === null) {
    return { retry: false, delayMs: 0, reason: next.exhaustedReason ?? "exhausted" };
  }
  // nextDelay clips the sleep to the remaining budget; a sleep that consumes all of it
  // leaves no time to actually issue the retry, so refuse rather than stall the client.
  if (elapsedMs + next.delayMs >= effectiveBudgetMs) {
    return {
      retry: false,
      delayMs: 0,
      reason: classification.park ? "park-hold-exhausted" : "budget-exhausted",
    };
  }
  return {
    retry: true,
    delayMs: next.delayMs,
    reason: classification.park ? `hold:${classification.class}` : `retry:${classification.class}`,
  };
}

/** Innermost `code` on an error or its cause chain (undici nests ECONNREFUSED under UND_ERR_*). */
export function extractErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur !== null && cur !== undefined && depth < 5; depth++) {
    if (typeof cur !== "object") return undefined;
    const node = cur as { code?: unknown; cause?: unknown };
    if (typeof node.code === "string") return node.code;
    cur = node.cause;
  }
  return undefined;
}

/** Flattened message across the error's cause chain, so nested markers stay classifiable. */
export function extractErrorMessage(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== null && cur !== undefined && depth < 5; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as Error & { cause?: unknown }).cause;
      continue;
    }
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (typeof cur === "object") {
      const node = cur as { message?: unknown; cause?: unknown };
      if (typeof node.message === "string") parts.push(node.message);
      cur = node.cause;
      continue;
    }
    break;
  }
  return parts.join(" | ") || String(err);
}

/**
 * Decode an error body for marker matching. A compressed body decodes to noise, so it is
 * skipped and classification falls back to the status alone.
 */
export function decodeErrorBody(buf: Buffer, headers: IncomingHttpHeaders): string {
  const enc = headerValue(headers, "content-encoding");
  if (enc && enc.trim().toLowerCase() !== "identity") return "";
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * Is the network reachable at all? Any HTTP answer counts — a 401 or 404 from the probe
 * endpoint still proves the path is up. Only a transport failure means offline. HEAD is
 * tried first; a HEAD-hostile endpoint falls back to GET before declaring an outage.
 */
export async function probeConnectivity(cfg: LifelineConfig): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await request(cfg.probeUrl, {
        method,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await res.body.dump();
      return true;
    } catch {
      // Try the next method; only exhausting both counts as offline.
    }
  }
  return false;
}

/**
 * Owns the `~/.lifeline/connectivity.json` contract the daemon consumes. Writes are
 * debounced to state *transitions* only: a 429 storm produces many CONN failures and the
 * daemon must not see them as repeated outages.
 */
class ConnectivityWatcher {
  private lastOnline: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private probing = false;

  constructor(
    private readonly cfg: LifelineConfig,
    private readonly log: Logger,
  ) {}

  /** Seed from the last written event so a restart doesn't re-announce a known state. */
  start(): void {
    const last = readJson<ConnectivityEvent | null>(paths.connectivity(), null);
    if (last && typeof last.online === "boolean") {
      this.lastOnline = last.online;
      // Restarted while the network was down: nothing may hit the gateway until it comes
      // back, so poll for recovery rather than waiting for traffic that cannot arrive.
      if (!last.online) this.startPolling();
    }
  }

  /** Called on every CONN-class failure. Probes once, then leaves the poller to it. */
  async noteConnFailure(reason: string): Promise<void> {
    if (this.probing || this.timer !== null) return;
    this.probing = true;
    try {
      const online = await probeConnectivity(this.cfg);
      if (online) {
        this.emit(true, "probe reachable after transport failure");
      } else {
        this.emit(false, reason);
        this.startPolling();
      }
    } finally {
      this.probing = false;
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startPolling(): void {
    if (this.timer !== null) return;
    const timer = setInterval(() => {
      void this.poll();
    }, CONNECTIVITY_POLL_MS);
    timer.unref();
    this.timer = timer;
  }

  private async poll(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      if (await probeConnectivity(this.cfg)) {
        this.emit(true, "connectivity restored");
        this.stop();
      }
    } finally {
      this.probing = false;
    }
  }

  private emit(online: boolean, reason: string): void {
    if (this.lastOnline === online) return; // debounce: transitions only
    this.lastOnline = online;
    const event: ConnectivityEvent = { online, at: Date.now(), reason };
    try {
      writeJsonAtomic(paths.connectivity(), event);
      this.log.info(`connectivity ${online ? "up" : "down"}`, reason);
    } catch (err) {
      this.log.warn("connectivity write failed", extractErrorMessage(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------

interface GatewayContext {
  cfg: LifelineConfig;
  log: Logger;
  policy: BackoffPolicy;
  connectivity: ConnectivityWatcher;
}

/** Buffer the request body so it can be replayed verbatim on every retry. */
async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks);
}

/** The one manufactured response in this proxy: no upstream reply exists to forward. */
function sendTransportFailure(res: ServerResponse, message: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  // Anthropic's own error envelope, so the client parses it and its message carries the
  // transport code (ECONNREFUSED etc) that lifeline's daemon classifies as CONN.
  const payload = Buffer.from(
    JSON.stringify({
      type: "error",
      error: { type: "api_error", message: `lifeline gateway: ${message}` },
    }),
    "utf8",
  );
  res.writeHead(502, {
    "content-type": "application/json",
    "content-length": String(payload.length),
  });
  res.end(payload);
}

/** Forward a fully-buffered upstream response unchanged. */
function commitBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  upstreamHeaders: IncomingHttpHeaders,
  body: Buffer,
): void {
  const headers = buildResponseHeaders(upstreamHeaders);
  const isHead = req.method === "HEAD";
  if (!isHead) headers["content-length"] = String(body.length);
  res.writeHead(status, headers);
  if (isHead) res.end();
  else res.end(body);
}

/**
 * Commit to streaming. Past this point the response is un-retryable: bytes are on the wire
 * and cannot be un-sent. Resolves when the client response is finished either way.
 */
function commitStream(
  res: ServerResponse,
  upstreamBody: Readable,
  status: number,
  upstreamHeaders: IncomingHttpHeaders,
  ctx: GatewayContext,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    res.writeHead(status, buildResponseHeaders(upstreamHeaders));
    // SSE events are small and latency-sensitive; neither Node's header buffer nor Nagle
    // may hold one back.
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    upstreamBody.on("error", (err: Error) => {
      const classification = classify({
        code: extractErrorCode(err),
        message: extractErrorMessage(err),
        streamPartiallyFlushed: true,
      });
      ctx.log.warn("upstream stream cut after flush", classification.reason);
      void ctx.connectivity.noteConnFailure(classification.reason);
      // Cannot un-send what is already downstream, and retrying would stitch a second response
      // onto the first. An ordinary EOF is worse: Claude Code treats the 200 as an unfinished
      // turn and leaves its compaction UI spinning for minutes. Anthropic streams carry terminal
      // faults as an SSE `error` event, so surface this safe, local failure before closing.
      if (!res.writableEnded && !res.destroyed) {
        const event = JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: "lifeline gateway: upstream stream ended before completion; retry the request",
          },
        });
        res.write(`event: error\ndata: ${event}\n\n`);
        res.end();
      }
      done();
    });

    res.on("close", () => {
      if (!res.writableFinished) upstreamBody.destroy();
      done();
    });
    res.on("finish", done);

    upstreamBody.pipe(res);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayContext,
): Promise<void> {
  const startedAt = Date.now();
  const { log } = ctx;
  const method = (req.method ?? "GET") as Dispatcher.HttpMethod;

  let clientGone = false;
  res.on("close", () => {
    if (!res.writableFinished) clientGone = true;
  });

  let body: Buffer;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    log.warn("client request body aborted", extractErrorMessage(err));
    return;
  }

  for (let attempt = 0; ; attempt++) {
    if (clientGone) return;

    // The route may have been repaired after a previous connection refusal, so derive all
    // upstream request details per attempt rather than pinning the stale URL before the loop.
    const cfg = ctx.cfg;
    const policy = ctx.policy;
    const upstreamBase = new URL(cfg.upstream);
    const target = buildUpstreamUrl(cfg.upstream, req.url ?? "/");
    const forwardHeaders = buildForwardHeaders(req.headers, upstreamBase.host);

    const controller = new AbortController();
    const abortOnClose = (): void => controller.abort();
    res.once("close", abortOnClose);

    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await request(target, {
        method,
        headers: forwardHeaders,
        body: body.length > 0 ? body : undefined,
        signal: controller.signal,
        // Bound the pre-commit phase to the retry budget: undici's 300s default would let
        // one hung attempt swallow the whole schedule.
        headersTimeout: Math.max(1_000, cfg.requestBudgetMs),
      });
    } catch (err) {
      res.removeListener("close", abortOnClose);
      if (clientGone) return;

      const classification = classify({
        code: extractErrorCode(err),
        message: extractErrorMessage(err),
      });
      if (classification.class === "CONN") {
        void ctx.connectivity.noteConnFailure(classification.reason);
        const repaired = repairRelayBridge(ctx.cfg, readRelayPort());
        if (repaired) {
          ctx.cfg = repaired;
          ctx.policy = gatewayPolicy(repaired);
          persistRelayBridge(repaired);
          log.warn("repaired Relay upstream after transport refusal", { port: repaired.relayBridge?.lastKnownPort });
          continue;
        }
      }
      const decision = shouldRetry(
        classification,
        attempt,
        Date.now() - startedAt,
        policy,
        cfg.requestBudgetMs,
        undefined,
        cfg.parkHoldMs,
      );
      if (decision.retry) {
        log.warn(
          `transport error, retry ${attempt + 1}/${policy.maxAttempts} in ${decision.delayMs}ms`,
          classification.reason,
        );
        await sleep(decision.delayMs);
        continue;
      }
      log.error(`transport error, giving up (${decision.reason})`, classification.reason);
      sendTransportFailure(res, extractErrorMessage(err));
      return;
    }

    const status = upstream.statusCode;
    const upstreamHeaders = upstream.headers;

    if (status >= 200 && status < 300) {
      // Success: commit before touching the body, so SSE flows through untouched.
      res.removeListener("close", abortOnClose);
      if (clientGone) {
        upstream.body.destroy();
        return;
      }
      await commitStream(res, upstream.body, status, upstreamHeaders, ctx);
      return;
    }

    // Non-2xx. These bodies are small JSON error envelopes (a streaming response is always
    // 200 and already committed above), so reading the whole thing is safe — and necessary:
    // the status alone can't tell a plain 429 from a usage-limit park, or a 400 from a
    // "prompt is too long", and the exact bytes must still be forwardable.
    let errorBody: Buffer;
    try {
      errorBody = Buffer.from(await upstream.body.arrayBuffer());
    } catch {
      errorBody = Buffer.alloc(0);
    }
    res.removeListener("close", abortOnClose);
    if (clientGone) return;

    const classification = classify({
      status,
      message: decodeErrorBody(errorBody, upstreamHeaders),
      retryAfterSeconds: parseRetryAfter(headerValue(upstreamHeaders, "retry-after"), Date.now()),
    });
    if (classification.class === "CONN") {
      void ctx.connectivity.noteConnFailure(classification.reason);
    }

    const decision = shouldRetry(
      classification,
      attempt,
      Date.now() - startedAt,
      policy,
      cfg.requestBudgetMs,
      undefined,
      cfg.parkHoldMs,
    );
    if (decision.retry) {
      log.warn(
        `upstream ${status}, retry ${attempt + 1}/${policy.maxAttempts} in ${decision.delayMs}ms`,
        classification.reason,
      );
      await sleep(decision.delayMs);
      continue;
    }

    log.debug(`forwarding upstream ${status} unchanged (${decision.reason})`, classification.reason);
    commitBuffer(req, res, status, upstreamHeaders, errorBody);
    return;
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface GatewayHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startGateway(cfg: LifelineConfig = loadConfig()): Promise<GatewayHandle> {
  // Do not override an explicit process-level upstream. For file-configured routes, adopt a
  // bridge marker only after exact positive identification against Relay's own persisted port.
  if (!process.env.LIFELINE_UPSTREAM) {
    const coherent = discardIncoherentRelayBridge(cfg);
    if (coherent) {
      cfg = coherent;
      persistRelayBridge(cfg);
    }
    const adopted = adoptRelayBridge(cfg, readRelayPort());
    if (adopted) {
      cfg = adopted;
      persistRelayBridge(cfg);
    }
  }
  const log = makeLogger("gateway");
  const connectivity = new ConnectivityWatcher(cfg, log);
  connectivity.start();

  const ctx: GatewayContext = { cfg, log, policy: gatewayPolicy(cfg), connectivity };

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err: unknown) => {
      log.error("request handler failed", extractErrorMessage(err));
      sendTransportFailure(res, extractErrorMessage(err));
    });
  });

  // A local proxy for long streaming responses and large prompt uploads: node's default
  // request/header timeouts would cut legitimate traffic, and the client owns its own.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(cfg.gatewayPort, cfg.gatewayHost, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : cfg.gatewayPort;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        connectivity.stop();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const cfg = loadConfig();
  const log = makeLogger("gateway");
  startGateway(cfg)
    .then(({ port }) => {
      log.info(`listening on http://${cfg.gatewayHost}:${port} -> ${cfg.upstream}`);
    })
    .catch((err: unknown) => {
      log.error("failed to start", extractErrorMessage(err));
      process.exitCode = 1;
    });
}
