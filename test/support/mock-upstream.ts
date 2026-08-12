/**
 * A controllable stand-in for the Anthropic API, driven by a SEEDED fault schedule.
 *
 * The schedule is a list of steps consumed in order; each step serves `times` requests (default
 * 1) and the LAST step is sticky, so `[{429, times: 1}, {200}]` reads as "429 once, then 200
 * forever". Every request is recorded in `requests`, which is how a test proves the gateway
 * retried exactly N times rather than inferring it from the response alone.
 *
 * Determinism: the only randomised behaviour is how an SSE payload is split across `write()`
 * calls, and that is driven by a seeded PRNG — the same seed always produces the same chunking,
 * so a truncation test cuts at the same boundary on every run.
 *
 * The fault vocabulary models the top forensic signatures (docs/forensics/FINDINGS.md):
 * 429 + Retry-After, 503 overloaded, usage-limit body, prompt-too-long 400, mid-flight SSE cut,
 * and — via `reserveClosedPort()` — a refused connection.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

/* ------------------------------------------------------------------ bodies */

/** A plain 429: rate limited, no usage-limit wording. Gateway must retry this on the socket. */
export const BODY_RATE_LIMIT = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "Number of requests has exceeded your limit" },
});

/** 5xx overload. Gateway must retry. */
export const BODY_OVERLOADED = JSON.stringify({
  type: "error",
  error: { type: "overloaded_error", message: "Overloaded" },
});

/**
 * The single biggest forensic killer (1,168 occurrences). Classified USAGE_LIMIT → park, so the
 * gateway must forward it rather than hold the client socket for the reset window.
 */
export const BODY_USAGE_LIMIT = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    message: "You have hit your session limit. Your limit resets at 3pm.",
  },
});

/**
 * A multi-account relay reporting that no member is eligible RIGHT NOW — the verbatim shape
 * seen when a fan-out lost its agents to one bad minute (2026-08-12). Same USAGE_LIMIT class
 * as a session limit, but holdable: the pool re-admits accounts as reserves roll over, so the
 * gateway holds briefly instead of handing the agent a death sentence.
 */
export const BODY_POOL_EXHAUSTED = JSON.stringify({
  error: "2 of 3 accounts at or over their usage reserve (1 needing re-login)",
  code: "no-eligible-account",
  reason: "over_reserve",
});

/** Terminal: needs compaction, never a blind retry. Must pass through byte-for-byte. */
export const BODY_PROMPT_TOO_LONG = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "prompt is too long: 250000 tokens > 200000 maximum",
  },
});

/** Terminal auth failure. */
export const BODY_AUTH = JSON.stringify({
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
});

/** A well-formed Anthropic message stream, ending in `message_stop`. */
export const DEFAULT_SSE_EVENTS: readonly string[] = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_lifeline","role":"assistant","content":[]}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tokens"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** The joined stream a non-truncated `sse` step serves. */
export function fullSseBody(events: readonly string[] = DEFAULT_SSE_EVENTS): string {
  return events.join("");
}

/* ------------------------------------------------------------------ schedule */

export interface StatusStep {
  kind: "status";
  status: number;
  /** Response body. Defaults to `{}`. Forwarded verbatim, so tests can assert byte equality. */
  body?: string;
  headers?: Record<string, string>;
  /** How many requests this step serves. Ignored on the last step, which is sticky. */
  times?: number;
}

export interface SseStep {
  kind: "sse";
  events?: readonly string[];
  /**
   * Flush only the first K bytes of the joined stream, then half-close the socket — the
   * "Connection closed mid-response" signature. Omit to serve the complete stream.
   */
  cutAfterBytes?: number;
  /** ms to wait after the last flush before cutting; lets the bytes land downstream first. */
  cutDelayMs?: number;
  times?: number;
}

/** Destroy the socket before any response — a transport error with no upstream reply. */
export interface HangupStep {
  kind: "hangup";
  times?: number;
}

export type MockStep = StatusStep | SseStep | HangupStep;

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Epoch ms the request arrived — how a test proves Retry-After was actually waited out. */
  at: number;
  /** Which schedule entry served it. */
  stepIndex: number;
  stepKind: MockStep["kind"];
}

export interface MockUpstream {
  url: string;
  port: number;
  /** Every request received, in arrival order. */
  requests: MockRequest[];
  close(): Promise<void>;
}

export interface MockOptions {
  /** Seeds the SSE chunk splitting. Same seed → same wire chunking. */
  seed?: number;
  host?: string;
}

/** mulberry32 — small, fast, and identical across runs for a given seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split a payload into deterministic write-sized chunks so a cut lands mid-stream, not mid-nothing. */
function splitChunks(payload: string, rand: () => number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < payload.length) {
    const size = 24 + Math.floor(rand() * 72);
    chunks.push(payload.slice(i, i + size));
    i += size;
  }
  return chunks;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    parts.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * Start the mock on an ephemeral port and return its URL plus the live request log.
 * Always `await close()` — the harness destroys lingering sockets so the process can exit.
 */
export async function makeMockUpstream(
  schedule: readonly MockStep[],
  options: MockOptions = {},
): Promise<MockUpstream> {
  if (schedule.length === 0) throw new Error("makeMockUpstream: schedule must not be empty");
  const host = options.host ?? "127.0.0.1";
  const rand = makeRng(options.seed ?? 1);
  const requests: MockRequest[] = [];
  const sockets = new Set<Socket>();

  let stepIndex = 0;
  let servedInStep = 0;

  /** Consume one unit of the schedule. The last step is sticky. */
  function take(): { step: MockStep; index: number } {
    const index = Math.min(stepIndex, schedule.length - 1);
    const step = schedule[index] as MockStep;
    if (stepIndex < schedule.length - 1) {
      servedInStep += 1;
      if (servedInStep >= (step.times ?? 1)) {
        stepIndex += 1;
        servedInStep = 0;
      }
    }
    return { step, index };
  }

  function serveStatus(res: ServerResponse, step: StatusStep): void {
    const body = Buffer.from(step.body ?? "{}", "utf8");
    res.writeHead(step.status, {
      "content-type": "application/json",
      "content-length": String(body.length),
      ...(step.headers ?? {}),
    });
    res.end(body);
  }

  function serveSse(res: ServerResponse, step: SseStep): void {
    const full = fullSseBody(step.events ?? DEFAULT_SSE_EVENTS);
    const cut = step.cutAfterBytes;
    const payload = cut === undefined ? full : full.slice(0, Math.max(0, cut));

    // No content-length: SSE is chunked, which is what makes a mid-flight cut observable as a
    // premature close rather than as a short-but-complete body.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.flushHeaders();

    const chunks = splitChunks(payload, rand);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] as string;
      const isLast = i === chunks.length - 1;
      res.write(chunk, () => {
        if (!isLast) return;
        if (cut === undefined) {
          res.end();
          return;
        }
        // Half-close (FIN) rather than destroy (RST): a reset can discard bytes already in the
        // peer's receive buffer, which would make the truncation test flaky about WHERE it cut.
        setTimeout(() => res.socket?.end(), step.cutDelayMs ?? 25);
      });
    }
    if (chunks.length === 0) {
      if (cut === undefined) res.end();
      else setTimeout(() => res.socket?.end(), step.cutDelayMs ?? 25);
    }
  }

  const server: Server = createServer((req, res) => {
    // A deliberate mid-flight cut ends with the socket closed under an unfinished response;
    // swallow the resulting write error so it never surfaces as an unhandled 'error' event.
    res.on("error", () => undefined);
    req.on("error", () => undefined);
    void (async () => {
      const body = await readBody(req).catch(() => "");
      const { step, index } = take();
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: { ...req.headers },
        body,
        at: Date.now(),
        stepIndex: index,
        stepKind: step.kind,
      });

      switch (step.kind) {
        case "status":
          serveStatus(res, step);
          return;
        case "sse":
          serveSse(res, step);
          return;
        case "hangup":
          res.socket?.destroy();
          return;
      }
    })();
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    url: `http://${host}:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

/**
 * A URL whose port is bound then released, so connecting to it yields ECONNREFUSED — the
 * "local proxy restarted" signature (197 forensic occurrences), without needing a live server.
 */
export async function reserveClosedPort(
  host = "127.0.0.1",
): Promise<{ url: string; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { url: `http://${host}:${port}`, port };
}

/**
 * Drain a response body without letting a premature close lose what already arrived — the
 * exact situation a truncated-SSE assertion needs to inspect.
 */
export async function readBodyTolerant(
  body: AsyncIterable<Buffer | string>,
): Promise<{ text: string; errored: boolean }> {
  const parts: Buffer[] = [];
  let errored = false;
  try {
    for await (const chunk of body) {
      parts.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    }
  } catch {
    errored = true;
  }
  return { text: Buffer.concat(parts).toString("utf8"), errored };
}
