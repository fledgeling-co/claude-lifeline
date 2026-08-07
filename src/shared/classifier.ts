/**
 * The error taxonomy every seam classifies against. Derived from forensics over 1,054
 * local workflow runs (docs/forensics/FINDINGS.md) and the retry-policy research
 * (docs/research/*.md). The class decides the recovery strategy.
 */
export type ErrorClass =
  | "RATE_LIMIT" // 429 / 529 — honour Retry-After, else jittered backoff
  | "OVERLOADED" // 5xx / overloaded_error — jittered backoff
  | "CONN" // ECONNREFUSED/RESET/ETIMEDOUT, truncated SSE — connectivity signal + short backoff
  | "USAGE_LIMIT" // session/usage limit, all-accounts-exhausted — park + scheduled retry
  | "CONTEXT" // prompt too long / autocompact thrash — terminal, never blind-retry
  | "AUTH" // 400/401/403/invalid_request — terminal
  | "STALL" // daemon-synthesized: no output/context change for the stall window — nudge + relaunch
  | "UNKNOWN"; // unclassified — treated conservatively as terminal at the daemon

export interface Classification {
  class: ErrorClass;
  retryable: boolean;
  /** true when recovery is a scheduled park (usage-limit), not a hot backoff loop. */
  park: boolean;
  /** Retry-After in ms if the source supplied one, else null. */
  retryAfterMs: number | null;
  reason: string;
}

const RATE_LIMIT_STATUS = new Set([429, 529]);
const OVERLOADED_STATUS = new Set([500, 502, 503, 504, 520, 522, 524]);
const AUTH_STATUS = new Set([400, 401, 403, 405, 422]);

const CONN_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

// Substrings observed in the forensic signatures (case-insensitive).
// No bare "reset" here: it would swallow ECONNRESET, and every real usage-limit
// signature already carries "session limit" / "usage limit" / "exhausted".
const USAGE_LIMIT_MARKERS = [
  "session limit",
  "usage limit",
  "you've hit your session limit",
  "all accounts for binding are exhausted",
  "all-accounts-exhausted",
];
// "Server is temporarily limiting requests (not your usage limit)" is 429-class and
// carries the words "usage limit" inside a negation; it must be tested BEFORE the
// usage-limit markers or 49 forensic occurrences park instead of backoff-retrying.
const RATE_LIMIT_NEGATION = "not your usage limit";
const RATE_LIMIT_MARKERS = [
  "rate limit",
  "temporarily limiting requests",
  "server is temporarily limiting requests",
];
const OVERLOADED_MARKERS = [
  "overloaded",
  "internal server error",
  "server-side issue",
  "server error mid-response",
  "response stalled mid-stream",
];
const CONN_MARKERS = [
  "unable to connect to api",
  "connectionrefused",
  "connection refused",
  "connection closed mid-response",
  "connection closed",
  "server error mid-response",
  "econnreset",
  "etimedout",
];
const CONTEXT_MARKERS = [
  "prompt is too long",
  "prompt too long",
  "context length",
  "maximum context",
  "autocompact is thrashing",
  "context refilled",
];

export interface ClassifyInput {
  /** HTTP status if this came from a response. */
  status?: number | undefined;
  /** Node/undici error code if this came from a thrown transport error. */
  code?: string | undefined;
  /** Raw error text / message / body — matched against the forensic markers. */
  message?: string | undefined;
  /** Parsed Retry-After header value in seconds, if present. */
  retryAfterSeconds?: number | undefined;
  /** True if the SSE stream was cut after some bytes were already flushed downstream. */
  streamPartiallyFlushed?: boolean | undefined;
}

function has(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Classify a failure into the taxonomy. Ordering matters: the most specific,
 * highest-signal classes are tested first so a generic 500 body that mentions a
 * usage limit is still parked, and a "prompt too long" is never retried as a 400.
 */
export function classify(input: ClassifyInput): Classification {
  const msg = (input.message ?? "").toLowerCase();
  const retryAfterMs =
    input.retryAfterSeconds != null && Number.isFinite(input.retryAfterSeconds)
      ? Math.max(0, Math.round(input.retryAfterSeconds * 1000))
      : null;

  // CONTEXT is terminal and must win over any status-based guess: a "prompt too
  // long" often arrives as a 400, which would otherwise read as AUTH.
  if (has(msg, CONTEXT_MARKERS)) {
    return {
      class: "CONTEXT",
      retryable: false,
      park: false,
      retryAfterMs,
      reason: "context/prompt too long — needs compaction, not retry",
    };
  }

  // Structural transport codes are higher-signal than any substring, and must precede
  // the text markers ("ECONNRESET" contains no usage-limit marker now, but keeping the
  // structural check first makes that robustness independent of marker wording).
  if (input.code && CONN_CODES.has(input.code)) {
    return {
      class: "CONN",
      retryable: true,
      park: false,
      retryAfterMs,
      reason: `transport error ${input.code} — connectivity signal`,
    };
  }

  // The 429-class negation phrase, before the usage-limit markers it contains.
  if (msg.includes(RATE_LIMIT_NEGATION)) {
    return {
      class: "RATE_LIMIT",
      retryable: true,
      park: false,
      retryAfterMs,
      reason: "server-side throttling (explicitly not the account's usage limit)",
    };
  }

  // USAGE_LIMIT is a scheduled park regardless of the carrying status.
  if (has(msg, USAGE_LIMIT_MARKERS)) {
    return {
      class: "USAGE_LIMIT",
      retryable: true,
      park: true,
      retryAfterMs,
      reason: "usage/session limit or accounts exhausted — park and retry on schedule",
    };
  }

  if (input.streamPartiallyFlushed) {
    return {
      class: "CONN",
      retryable: true,
      park: false,
      retryAfterMs,
      reason: "SSE stream cut after partial flush — cannot un-send, surface as CONN",
    };
  }

  if (input.status != null) {
    if (RATE_LIMIT_STATUS.has(input.status)) {
      return {
        class: "RATE_LIMIT",
        retryable: true,
        park: false,
        retryAfterMs,
        reason: `status ${input.status} rate limited`,
      };
    }
    if (OVERLOADED_STATUS.has(input.status)) {
      return {
        class: "OVERLOADED",
        retryable: true,
        park: false,
        retryAfterMs,
        reason: `status ${input.status} overloaded/server error`,
      };
    }
    if (AUTH_STATUS.has(input.status)) {
      return {
        class: "AUTH",
        retryable: false,
        park: false,
        retryAfterMs,
        reason: `status ${input.status} client/auth error — terminal`,
      };
    }
  }

  // Text-only fallbacks (a null-return apiError string with no status/code).
  if (has(msg, CONN_MARKERS)) {
    return {
      class: "CONN",
      retryable: true,
      park: false,
      retryAfterMs,
      reason: "connectivity marker in message",
    };
  }
  if (has(msg, RATE_LIMIT_MARKERS)) {
    return {
      class: "RATE_LIMIT",
      retryable: true,
      park: false,
      retryAfterMs,
      reason: "rate-limit marker in message",
    };
  }
  if (has(msg, OVERLOADED_MARKERS)) {
    return {
      class: "OVERLOADED",
      retryable: true,
      park: false,
      retryAfterMs,
      reason: "overloaded marker in message",
    };
  }

  return {
    class: "UNKNOWN",
    retryable: false,
    park: false,
    retryAfterMs,
    reason: "unclassified — treated as terminal",
  };
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into seconds from now. */
export function parseRetryAfter(headerValue: string | null | undefined, nowMs: number): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  // Delta-seconds form. A negative delta is malformed (RFC 9110 requires non-negative),
  // and must not fall through to Date.parse, which reads "-5" as a year.
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 0 ? n : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, (when - nowMs) / 1000);
}
