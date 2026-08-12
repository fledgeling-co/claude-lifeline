/**
 * Classifier evals — table-driven over the REAL forensic signatures.
 *
 * Every row is drawn from docs/forensics/FINDINGS.md's ranked error table (1,054 runs, 4,630
 * agents). The class decides the recovery strategy, so a misread here is a wrong strategy
 * everywhere downstream: a parked 429 wastes minutes, a retried CONTEXT burns 30 attempts on
 * a prompt that can never fit.
 */

import { describe, expect, it } from "vitest";
import type { ClassifyInput, ErrorClass } from "../../src/shared/classifier.js";
import { classify, parseRetryAfter } from "../../src/shared/classifier.js";
import {
  BODY_AUTH,
  BODY_OVERLOADED,
  BODY_PROMPT_TOO_LONG,
  BODY_RATE_LIMIT,
  BODY_USAGE_LIMIT,
} from "../support/mock-upstream.js";

interface Row {
  /** Forensic signature name, matching the FINDINGS.md ranking where applicable. */
  name: string;
  input: ClassifyInput;
  expected: ErrorClass;
  retryable: boolean;
  park: boolean;
  /** Asserted only where the row states it; `park` rows are the ones that care. */
  holdable?: boolean;
}

const TABLE: Row[] = [
  // 1 — session/usage limit (1,168 occurrences; the biggest killer).
  {
    name: "session limit (transcript text)",
    input: { message: "API Error: You have hit your session limit. Your limit resets at 3pm." },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
  },
  {
    name: "session limit (429 body from upstream)",
    input: { status: 429, message: BODY_USAGE_LIMIT },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
  },
  {
    name: "usage limit reached",
    input: { message: "Claude usage limit reached" },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
  },
  // 10 — proxy multi-account exhaustion (46 occurrences).
  {
    name: "all accounts for binding are exhausted",
    input: { message: "Error: all accounts for binding are exhausted" },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
  },
  {
    name: "all-accounts-exhausted (snap form)",
    input: { message: "all-accounts-exhausted" },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
  },
  {
    name: "Relay no-eligible-account 503",
    input: {
      status: 503,
      message: '{"code":"no-eligible-account","reason":"over_reserve"}',
    },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
    // A pool, not an account: members return as reserves roll over, so the gateway may hold.
    holdable: true,
  },
  {
    name: "Relay over_reserve wording without the code (2026-08-12 fan-out)",
    input: {
      status: 503,
      message:
        'API Error: 503 {"error":"2 of 3 accounts at or over their usage reserve (1 needing re-login)",' +
        '"code":"no-eligible-account","reason":"over_reserve"}',
    },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
    holdable: true,
  },
  {
    name: "all accounts for binding are exhausted",
    input: { message: "all accounts for binding are exhausted" },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
    holdable: true,
  },
  {
    name: "one account's own session limit is parked but never held",
    input: { message: "API Error: You have hit your session limit. Your limit resets at 3pm." },
    expected: "USAGE_LIMIT",
    retryable: true,
    park: true,
    holdable: false,
  },

  // 2 — rate limited (271 occurrences with variants).
  {
    name: "Rate limited (text only)",
    input: { message: "API Error: Rate limited. Please try again later." },
    expected: "RATE_LIMIT",
    retryable: true,
    park: false,
  },
  {
    name: "429 with a plain rate-limit body",
    input: { status: 429, message: BODY_RATE_LIMIT },
    expected: "RATE_LIMIT",
    retryable: true,
    park: false,
  },
  {
    name: "529 (Anthropic overloaded-as-rate-limit status)",
    input: { status: 529, message: "" },
    expected: "RATE_LIMIT",
    retryable: true,
    park: false,
  },
  {
    name: "temporarily limiting requests (no usage-limit disclaimer)",
    input: { message: "The server is temporarily limiting requests." },
    expected: "RATE_LIMIT",
    retryable: true,
    park: false,
  },

  // 3 — ConnectionRefused (197 occurrences); the user's local multi-account proxy restarting.
  {
    name: "ECONNREFUSED transport code",
    input: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:4000" },
    expected: "CONN",
    retryable: true,
    park: false,
  },
  {
    name: "ConnectionRefused (transcript text, no code)",
    input: { message: "API Error: ConnectionRefused (os error 61)" },
    expected: "CONN",
    retryable: true,
    park: false,
  },
  {
    name: "Unable to connect to API",
    input: { message: "Unable to connect to API" },
    expected: "CONN",
    retryable: true,
    park: false,
  },
  {
    name: "ETIMEDOUT transport code",
    input: { code: "ETIMEDOUT", message: "socket timeout" },
    expected: "CONN",
    retryable: true,
    park: false,
  },
  {
    name: "undici socket error",
    input: { code: "UND_ERR_SOCKET", message: "other side closed" },
    expected: "CONN",
    retryable: true,
    park: false,
  },

  // 6 — Connection closed mid-response (111 occurrences); the truncated-SSE signature.
  {
    name: "Connection closed mid-response",
    input: { message: "API Error: Connection closed mid-response" },
    expected: "CONN",
    retryable: true,
    park: false,
  },
  {
    name: "SSE cut after bytes were already flushed downstream",
    input: { streamPartiallyFlushed: true, message: "terminated" },
    expected: "CONN",
    retryable: true,
    park: false,
  },

  // 4, 9, 12 — 5xx / overloaded (139 occurrences with variants).
  {
    name: "503 overloaded body",
    input: { status: 503, message: BODY_OVERLOADED },
    expected: "OVERLOADED",
    retryable: true,
    park: false,
  },
  {
    name: "Overloaded (text only)",
    input: { message: "API Error: Overloaded" },
    expected: "OVERLOADED",
    retryable: true,
    park: false,
  },
  {
    name: "500 Internal server error",
    input: { status: 500, message: "API Error: 500 Internal server error" },
    expected: "OVERLOADED",
    retryable: true,
    park: false,
  },
  {
    name: "502 bad gateway (no body)",
    input: { status: 502 },
    expected: "OVERLOADED",
    retryable: true,
    park: false,
  },
  {
    name: "response stalled mid-stream",
    input: { message: "response stalled mid-stream" },
    expected: "OVERLOADED",
    retryable: true,
    park: false,
  },

  // 5, 8 — context overflow (117 occurrences). TERMINAL: must never be blind-retried.
  {
    name: "Prompt is too long (400 status)",
    input: { status: 400, message: BODY_PROMPT_TOO_LONG },
    expected: "CONTEXT",
    retryable: false,
    park: false,
  },
  {
    name: "Prompt is too long (text only)",
    input: { message: "API Error: Prompt is too long" },
    expected: "CONTEXT",
    retryable: false,
    park: false,
  },
  {
    name: "Autocompact is thrashing",
    input: { message: "Autocompact is thrashing: context refilled to limit" },
    expected: "CONTEXT",
    retryable: false,
    park: false,
  },

  // Auth / client errors. TERMINAL.
  {
    name: "401 authentication_error",
    input: { status: 401, message: BODY_AUTH },
    expected: "AUTH",
    retryable: false,
    park: false,
  },
  {
    name: "403 forbidden",
    input: { status: 403, message: '{"type":"error","error":{"type":"permission_error"}}' },
    expected: "AUTH",
    retryable: false,
    park: false,
  },
  {
    name: "400 invalid_request (not a context overflow)",
    input: { status: 400, message: '{"type":"error","error":{"type":"invalid_request_error"}}' },
    expected: "AUTH",
    retryable: false,
    park: false,
  },

  // Unclassified — treated conservatively as terminal so the daemon never blind-retries noise.
  {
    name: "unrecognised failure",
    input: { message: "worktree creation failure" },
    expected: "UNKNOWN",
    retryable: false,
    park: false,
  },
  {
    name: "empty input",
    input: {},
    expected: "UNKNOWN",
    retryable: false,
    park: false,
  },
];

describe("classify — forensic signature table", () => {
  it.each(TABLE)("$name -> $expected", (row) => {
    const result = classify(row.input);
    expect(result.class).toBe(row.expected);
    expect(result.retryable).toBe(row.retryable);
    expect(result.park).toBe(row.park);
    if (row.holdable !== undefined) expect(result.holdable).toBe(row.holdable);
    expect(result.reason).toBeTruthy();
  });

  it("only a park is ever holdable — nothing else may be slept on inside a request", () => {
    for (const row of TABLE) {
      const result = classify(row.input);
      if (!result.park) expect(result.holdable).toBe(false);
    }
  });

  it("parks only for USAGE_LIMIT — every other class is a hot loop or terminal", () => {
    for (const row of TABLE) {
      const result = classify(row.input);
      expect(result.park).toBe(result.class === "USAGE_LIMIT");
    }
  });

  it("never marks a terminal class retryable", () => {
    for (const cls of ["CONTEXT", "AUTH", "UNKNOWN"] as const) {
      for (const row of TABLE.filter((r) => r.expected === cls)) {
        expect(classify(row.input).retryable).toBe(false);
      }
    }
  });

  it("CONTEXT wins over the 400 that carries it (a prompt overflow is not an auth error)", () => {
    const asAuth = classify({ status: 400, message: '{"error":{"type":"invalid_request_error"}}' });
    const asContext = classify({ status: 400, message: BODY_PROMPT_TOO_LONG });
    expect(asAuth.class).toBe("AUTH");
    expect(asContext.class).toBe("CONTEXT");
  });

  it("USAGE_LIMIT wins over the status carrying it (a 500 that says session limit still parks)", () => {
    expect(classify({ status: 500, message: BODY_USAGE_LIMIT }).class).toBe("USAGE_LIMIT");
  });

  it("carries Retry-After through as milliseconds", () => {
    expect(classify({ status: 429, retryAfterSeconds: 2 }).retryAfterMs).toBe(2000);
    expect(classify({ status: 429, retryAfterSeconds: 0 }).retryAfterMs).toBe(0);
    expect(classify({ status: 429 }).retryAfterMs).toBeNull();
    expect(classify({ status: 429, retryAfterSeconds: Number.NaN }).retryAfterMs).toBeNull();
  });
});

/**
 * Marker overlaps the daemon build surfaced as classifier bugs, now FIXED and blessed:
 * the 429-class negation phrase wins over the "usage limit" words it contains, and a
 * structural transport code wins over any message substring. See FINDINGS.md rows 3 and 7.
 */
describe("classify — marker overlaps (fixed and blessed)", () => {
  it('reads "not your usage limit" as RATE_LIMIT (429-class), not a parked usage limit', () => {
    const result = classify({
      status: 429,
      message: "Server is temporarily limiting requests (not your usage limit)",
    });
    expect(result.class).toBe("RATE_LIMIT");
    expect(result.park).toBe(false);
    // Whatever the class, the safety-critical properties hold: it retries and is not terminal.
    expect(result.retryable).toBe(true);
  });

  it("reads a transport code as CONN even when the message mentions ECONNRESET", () => {
    // The structural code outranks message substrings, so both forms classify as CONN.
    expect(classify({ code: "ECONNRESET", message: "read ECONNRESET" }).class).toBe("CONN");
    expect(classify({ code: "ECONNRESET", message: "socket hang up" }).class).toBe("CONN");
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120);
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("  30  ", NOW)).toBe(30);
  });

  it("parses an HTTP-date into seconds from now", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:30 GMT", NOW)).toBe(30);
    expect(parseRetryAfter("Wed, 21 Oct 2015 08:28:00 GMT", NOW)).toBe(3600);
  });

  it("clamps a past HTTP-date to zero rather than returning a negative delay", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:27:00 GMT", NOW)).toBe(0);
  });

  it("returns undefined for absent or unparseable values", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter("", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter("-5", NOW)).toBeUndefined();
  });

  it("feeds classify end-to-end: header -> seconds -> classification retryAfterMs", () => {
    const seconds = parseRetryAfter("2", NOW);
    expect(classify({ status: 429, retryAfterSeconds: seconds }).retryAfterMs).toBe(2000);
  });
});
