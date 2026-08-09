/**
 * Gateway integration evals — the real `lifeline-gw` in front of a scripted mock upstream.
 *
 * These are the acceptance tests for spec §A and criterion 1. The mock records every request,
 * so "the gateway retried" is proven by what the upstream SAW, not inferred from the response
 * the client happened to get.
 *
 * Two invariants under test throughout:
 *   - commit-once: a retry is only legal while zero response bytes have reached the client
 *   - never synthesize: a terminal or parked response is forwarded byte-for-byte
 */

import { afterEach, describe, expect, it } from "vitest";
import { request } from "undici";
import { classify } from "../../src/shared/classifier.js";
import { readJson } from "../../src/shared/io.js";
import { paths } from "../../src/shared/paths.js";
import type { ConnectivityEvent } from "../../src/shared/types.js";
import { DEFAULT_CONFIG } from "../../src/shared/config.js";
import type { LifelineConfig } from "../../src/shared/config.js";
import type { GatewayHandle } from "../../src/gateway/server.js";
import {
  buildForwardHeaders,
  buildResponseHeaders,
  buildUpstreamUrl,
  adoptRelayBridge,
  discardIncoherentRelayBridge,
  decodeErrorBody,
  extractErrorCode,
  extractErrorMessage,
  gatewayPolicy,
  headerValue,
  repairRelayBridge,
  shouldRetry,
  startGateway,
} from "../../src/gateway/server.js";
import {
  BODY_AUTH,
  BODY_OVERLOADED,
  BODY_PROMPT_TOO_LONG,
  BODY_RATE_LIMIT,
  BODY_USAGE_LIMIT,
  fullSseBody,
  makeMockUpstream,
  readBodyTolerant,
  reserveClosedPort,
} from "../support/mock-upstream.js";
import type { MockStep, MockUpstream } from "../support/mock-upstream.js";
import { useTempEnv, waitFor } from "../support/tmp.js";

const MESSAGES_PATH = "/v1/messages";
const CLIENT_BODY = JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "hi" }] });

/** Narrowing helper so assertions read as assertions rather than as optional chaining. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/**
 * A deliberately tight test config: small budgets keep the whole file bounded in wall-clock
 * while still exercising the real retry loop rather than a mocked one.
 */
function testConfig(upstream: string, over: Partial<LifelineConfig> = {}): LifelineConfig {
  return {
    ...DEFAULT_CONFIG,
    gatewayHost: "127.0.0.1",
    gatewayPort: 0, // ephemeral
    upstream,
    probeUrl: `${upstream}/`,
    requestBudgetMs: 6_000,
    gatewayMaxAttempts: 6,
    ...over,
  };
}

describe("gateway retry", () => {
  useTempEnv();

  /** Everything started by a test, torn down in reverse order however the test ended. */
  let upstream: MockUpstream | null = null;
  let gateway: GatewayHandle | null = null;

  afterEach(async () => {
    try {
      await gateway?.close();
    } finally {
      gateway = null;
      await upstream?.close();
      upstream = null;
    }
  });

  async function bring(schedule: MockStep[], over: Partial<LifelineConfig> = {}): Promise<string> {
    upstream = await makeMockUpstream(schedule, { seed: 42 });
    gateway = await startGateway(testConfig(upstream.url, over));
    return `http://127.0.0.1:${gateway.port}`;
  }

  function seen(): MockUpstream {
    if (upstream === null) throw new Error("upstream not started");
    return upstream;
  }

  async function post(base: string, path = MESSAGES_PATH) {
    return request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: CLIENT_BODY,
    });
  }

  it("1. a 429 with Retry-After is retried and the client only ever sees the 200", async () => {
    const base = await bring([
      { kind: "status", status: 429, body: BODY_RATE_LIMIT, headers: { "retry-after": "1" }, times: 1 },
      { kind: "status", status: 200, body: '{"ok":true}' },
    ]);

    const res = await post(base);
    const body = await res.body.text();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });

    // The upstream saw exactly one retry, and the request was replayed verbatim.
    const requests = seen().requests;
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.url)).toEqual([MESSAGES_PATH, MESSAGES_PATH]);
    expect(requests.map((r) => r.body)).toEqual([CLIENT_BODY, CLIENT_BODY]);
    expect(requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");

    // Retry-After: 1 was honoured verbatim rather than replaced by sub-second jitter.
    const gap = (requests[1]?.at ?? 0) - (requests[0]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(950);
    expect(gap).toBeLessThan(4_000);
  });

  it("2. a 503 storm inside the budget recovers without the client seeing a failure", async () => {
    const base = await bring([
      { kind: "status", status: 503, body: BODY_OVERLOADED, times: 2 },
      { kind: "status", status: 200, body: '{"ok":true}' },
    ]);

    const res = await post(base);
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('{"ok":true}');
    expect(seen().requests).toHaveLength(3);
    expect(seen().requests.map((r) => r.stepKind)).toEqual(["status", "status", "status"]);
  });

  it("2b. a storm that outlives the budget forwards the real upstream error, never a synthetic one", async () => {
    const base = await bring([{ kind: "status", status: 503, body: BODY_OVERLOADED }], {
      requestBudgetMs: 1_200,
      gatewayMaxAttempts: 3,
    });

    const res = await post(base);
    expect(res.statusCode).toBe(503);
    // Byte-for-byte the upstream body: the gateway must not manufacture an envelope here.
    expect(await res.body.text()).toBe(BODY_OVERLOADED);
    expect(seen().requests.length).toBeGreaterThanOrEqual(1);
    expect(seen().requests.length).toBeLessThanOrEqual(4);
  });

  it("3. an SSE stream cut after bytes were flushed is surfaced, not retried into a corrupt stream", async () => {
    const CUT_AFTER = 420;
    const base = await bring([{ kind: "sse", cutAfterBytes: CUT_AFTER }]);

    const res = await post(base);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const { text } = await readBodyTolerant(res.body);

    // The client received a strict PREFIX of the real stream — never a second attempt's bytes
    // stitched onto the first, which is what a naive retry-after-commit would produce.
    const full = fullSseBody();
    expect(text.length).toBeLessThanOrEqual(CUT_AFTER);
    expect(text.length).toBeGreaterThan(0);
    expect(full.startsWith(text)).toBe(true);

    // The stream is visibly incomplete: no terminal event arrived.
    expect(text).not.toContain("message_stop");
    expect(text).toContain("message_start");

    // And, decisively, the upstream was asked exactly once.
    expect(seen().requests).toHaveLength(1);
  });

  it("3b. an intact SSE stream is relayed unchanged", async () => {
    const base = await bring([{ kind: "sse" }]);

    const res = await post(base);
    expect(res.statusCode).toBe(200);
    const { text, errored } = await readBodyTolerant(res.body);
    expect(errored).toBe(false);
    expect(text).toBe(fullSseBody());
    expect(seen().requests).toHaveLength(1);
  });

  it("4. a prompt-too-long 400 passes through unchanged and is never retried", async () => {
    const base = await bring([{ kind: "status", status: 400, body: BODY_PROMPT_TOO_LONG }]);

    const res = await post(base);
    expect(res.statusCode).toBe(400);
    expect(await res.body.text()).toBe(BODY_PROMPT_TOO_LONG);
    expect(seen().requests).toHaveLength(1);
  });

  it("4b. a 401 passes through unchanged and is never retried", async () => {
    const base = await bring([{ kind: "status", status: 401, body: BODY_AUTH }]);

    const res = await post(base);
    expect(res.statusCode).toBe(401);
    expect(await res.body.text()).toBe(BODY_AUTH);
    expect(seen().requests).toHaveLength(1);
  });

  it("5. a usage limit is forwarded to the daemon rather than held on the client socket", async () => {
    // Retry-After of an hour: retrying this in-request would blow past the CLI's own SDK
    // timeout, so the gateway must park it by forwarding rather than sleeping.
    const started = Date.now();
    const base = await bring([
      { kind: "status", status: 429, body: BODY_USAGE_LIMIT, headers: { "retry-after": "3600" } },
    ]);

    const res = await post(base);
    expect(res.statusCode).toBe(429);
    expect(await res.body.text()).toBe(BODY_USAGE_LIMIT);
    expect(res.headers["retry-after"]).toBe("3600");
    expect(seen().requests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("6. a refused upstream becomes a 502 carrying the transport code, and marks connectivity down", async () => {
    const dead = await reserveClosedPort();
    gateway = await startGateway(
      testConfig(dead.url, { requestBudgetMs: 1_200, gatewayMaxAttempts: 3, probeUrl: `${dead.url}/` }),
    );
    const base = `http://127.0.0.1:${gateway.port}`;

    const res = await post(base);
    expect(res.statusCode).toBe(502);

    const payload = JSON.parse(await res.body.text()) as { error?: { message?: string } };
    expect(payload.error?.message).toContain("lifeline gateway");
    expect(payload.error?.message).toContain("ECONNREFUSED");

    // The gateway's half of the daemon contract: a transport outage is published as an event.
    const wrote = await waitFor(
      () => readJson<ConnectivityEvent | null>(paths.connectivity(), null)?.online === false,
      3_000,
    );
    expect(wrote).toBe(true);
  });

  it("7. a healthy request is transparent — one upstream call, path and end-to-end headers preserved", async () => {
    const base = await bring([{ kind: "status", status: 200, body: '{"ok":true}' }]);

    const res = await request(`${base}/v1/models?limit=2`, {
      method: "GET",
      headers: { "anthropic-version": "2023-06-01", "x-api-key": "sk-test" },
    });
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('{"ok":true}');

    const requests = seen().requests;
    expect(requests).toHaveLength(1);
    const forwarded = must(requests[0], "forwarded request");
    expect(forwarded.url).toBe("/v1/models?limit=2");
    expect(forwarded.method).toBe("GET");
    // End-to-end headers survive untouched; `host` is repointed at the upstream authority.
    expect(forwarded.headers["anthropic-version"]).toBe("2023-06-01");
    expect(forwarded.headers["x-api-key"]).toBe("sk-test");
    expect(forwarded.headers["host"]).toBe(new URL(seen().url).host);
  });
});

/**
 * The header and URL plumbing, tested directly. Hop-by-hop stripping cannot be exercised
 * through a real client — undici refuses to send a custom `Connection` header at all — so the
 * exported pure helpers are the honest place to pin it.
 */
describe("gateway header and URL plumbing", () => {
  it("drops hop-by-hop headers and everything the Connection header names", () => {
    const forwarded = buildForwardHeaders(
      {
        host: "127.0.0.1:8787",
        "content-length": "42",
        "anthropic-version": "2023-06-01",
        connection: "keep-alive, x-hop-token",
        "keep-alive": "timeout=5",
        "proxy-authorization": "Basic abc",
        "transfer-encoding": "chunked",
        "x-hop-token": "should-be-dropped",
        "x-end-to-end": "should-survive",
      },
      "api.anthropic.com",
    );

    expect(forwarded["host"]).toBe("api.anthropic.com");
    expect(forwarded["anthropic-version"]).toBe("2023-06-01");
    expect(forwarded["x-end-to-end"]).toBe("should-survive");
    for (const dropped of [
      "connection",
      "keep-alive",
      "proxy-authorization",
      "transfer-encoding",
      "x-hop-token",
      // Dropped because the body is replayed from a buffer and undici recomputes the length;
      // a stale value would desync a retried request.
      "content-length",
    ]) {
      expect(forwarded[dropped]).toBeUndefined();
    }
  });

  it("relays end-to-end response headers and strips the hop-by-hop ones", () => {
    const relayed = buildResponseHeaders({
      "content-type": "text/event-stream",
      "retry-after": "30",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    });
    expect(relayed["content-type"]).toBe("text/event-stream");
    expect(relayed["retry-after"]).toBe("30");
    expect(relayed["connection"]).toBeUndefined();
    expect(relayed["transfer-encoding"]).toBeUndefined();
  });

  it("joins the upstream prefix with the request target, and cannot be retargeted", () => {
    expect(buildUpstreamUrl("https://api.anthropic.com", "/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    // A user's multi-account proxy may carry a path prefix; it must be preserved.
    expect(buildUpstreamUrl("https://proxy.local/anthropic", "/v1/messages")).toBe(
      "https://proxy.local/anthropic/v1/messages",
    );
    expect(buildUpstreamUrl("https://proxy.local/anthropic/", "/v1/messages?x=1")).toBe(
      "https://proxy.local/anthropic/v1/messages?x=1",
    );
    // A protocol-relative request target must NOT become a different origin.
    expect(buildUpstreamUrl("https://api.anthropic.com", "//evil.example/v1/messages")).toBe(
      "https://api.anthropic.com/evil.example/v1/messages",
    );
  });

  it("repairs only a positively identified Relay bridge after its port moves", () => {
    const source = { ...DEFAULT_CONFIG, upstream: "http://127.0.0.1:8858" };
    const adopted = must(adoptRelayBridge(source, 8858), "Relay bridge");
    expect(adopted.relayBridge).toEqual({ lastKnownPort: 8858 });

    const repaired = must(repairRelayBridge(adopted, 8859), "repaired Relay bridge");
    expect(repaired.upstream).toBe("http://127.0.0.1:8859");
    expect(repaired.relayBridge).toEqual({ lastKnownPort: 8859 });

    // A generic local upstream is not a Relay bridge and therefore can never be rewritten.
    expect(repairRelayBridge({ ...source, upstream: "http://127.0.0.1:9000" }, 8859)).toBeNull();
    expect(repairRelayBridge({ ...adopted, upstream: "http://127.0.0.1:9000" }, 8859)).toBeNull();
  });

  it("clears a legacy Relay marker when its upstream was replaced", () => {
    const coherent = must(adoptRelayBridge(
      { ...DEFAULT_CONFIG, upstream: "http://127.0.0.1:8858" },
      8858,
    ), "Relay bridge");
    const stale = { ...coherent, upstream: "http://127.0.0.1:8857" };

    // Preserve the newer explicit route: the marker is only identity evidence, never authority
    // to overwrite another local proxy. With no marker, a later exact match can adopt afresh.
    expect(discardIncoherentRelayBridge(stale)).toEqual({
      ...DEFAULT_CONFIG,
      upstream: "http://127.0.0.1:8857",
    });
    expect(adoptRelayBridge(stale, 8857)).toBeNull();
  });

  it("headerValue takes the first value of a repeated header", () => {
    // Node models repeated headers as arrays; the classifier only ever wants the first.
    expect(headerValue({ "x-repeated": ["30", "60"] }, "x-repeated")).toBe("30");
    expect(headerValue({ "retry-after": "30" }, "retry-after")).toBe("30");
    expect(headerValue({}, "retry-after")).toBeUndefined();
  });

  it("decodeErrorBody refuses to classify a compressed body as text", () => {
    const body = Buffer.from(BODY_USAGE_LIMIT, "utf8");
    expect(decodeErrorBody(body, {})).toBe(BODY_USAGE_LIMIT);
    expect(decodeErrorBody(body, { "content-encoding": "identity" })).toBe(BODY_USAGE_LIMIT);
    expect(decodeErrorBody(body, { "content-encoding": "gzip" })).toBe("");
  });

  it("extracts a transport code and message from a nested cause chain", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4000"), {
      code: "ECONNREFUSED",
    });
    const outer = Object.assign(new Error("fetch failed"), { cause: inner });
    expect(extractErrorCode(outer)).toBe("ECONNREFUSED");
    expect(extractErrorMessage(outer)).toContain("ECONNREFUSED");
    expect(extractErrorMessage(outer)).toContain("fetch failed");
  });

  it("shouldRetry: retries a transient class, parks a usage limit, refuses a terminal one", () => {
    const policy = gatewayPolicy({ ...DEFAULT_CONFIG, gatewayMaxAttempts: 5, requestBudgetMs: 10_000 });

    const transient = shouldRetry(classify({ status: 503 }), 0, 0, policy, 10_000, () => 0.5);
    expect(transient.retry).toBe(true);
    expect(transient.delayMs).toBe(500);

    // A park heals in minutes to hours; holding the client socket would trip the SDK timeout.
    const parked = shouldRetry(classify({ status: 429, message: BODY_USAGE_LIMIT }), 0, 0, policy, 10_000);
    expect(parked.retry).toBe(false);
    expect(parked.reason).toContain("park");

    const terminal = shouldRetry(classify({ status: 401 }), 0, 0, policy, 10_000);
    expect(terminal.retry).toBe(false);
    expect(terminal.reason).toContain("terminal");

    // A sleep that would consume the whole remaining budget leaves no time to issue the retry.
    const noRoom = shouldRetry(classify({ status: 503 }), 0, 9_900, policy, 10_000, () => 0.99);
    expect(noRoom.retry).toBe(false);
    expect(noRoom.reason).toBe("budget-exhausted");
  });
});
