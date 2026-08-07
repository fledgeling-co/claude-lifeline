/**
 * Full-Jitter exponential backoff (AWS Brooker; docs/research/research-local-claude.md §1.1).
 *   sleep = random(0, min(cap, base * 2^attempt))
 *
 * Retry-After, when the source supplied one, overrides the computed backoff verbatim.
 * A retry schedule is also duration-bounded: 30 attempts at a 60s cap is ~30 min, so a
 * caller passes a deadline and `nextDelay` reports exhaustion rather than churning forever.
 */

export interface BackoffPolicy {
  /** Base delay in ms (first attempt window). */
  baseMs: number;
  /** Maximum single delay in ms. */
  capMs: number;
  /** Maximum number of attempts before giving up. */
  maxAttempts: number;
  /** Optional wall-clock budget across all attempts, in ms. */
  maxDurationMs?: number;
}

export const DEFAULT_POLICY: BackoffPolicy = {
  baseMs: 1000,
  capMs: 60000,
  maxAttempts: 30,
  maxDurationMs: 60 * 60 * 1000, // 1h — a truly dead binding parks rather than churns
};

/** The uncapped-by-nothing exponential ceiling for a given attempt, before jitter. */
export function exponentialCeiling(policy: BackoffPolicy, attempt: number): number {
  // attempt is 0-based (0 = first retry). 2^attempt can overflow for large attempts;
  // clamp the exponent so the multiply stays finite before the cap is applied.
  const exp = Math.min(attempt, 53);
  const raw = policy.baseMs * Math.pow(2, exp);
  return Math.min(policy.capMs, raw);
}

export interface NextDelay {
  /** Delay to sleep in ms, or null when the schedule is exhausted. */
  delayMs: number | null;
  /** Why the schedule ended, when delayMs is null. */
  exhaustedReason?: "max-attempts" | "max-duration";
}

export interface NextDelayInput {
  policy: BackoffPolicy;
  /** 0-based attempt index about to be made (0 = first retry). */
  attempt: number;
  /** Retry-After in ms from the source, if any — overrides computed backoff. */
  retryAfterMs?: number | null;
  /** ms already elapsed across this retry schedule, for the duration bound. */
  elapsedMs?: number;
  /** Injectable RNG in [0,1) for deterministic tests; defaults to Math.random. */
  rng?: () => number;
}

/**
 * Compute the next delay for an attempt, applying Full Jitter, the Retry-After override,
 * the attempt cap, and the optional duration budget.
 */
export function nextDelay(input: NextDelayInput): NextDelay {
  const { policy, attempt } = input;
  const rng = input.rng ?? Math.random;
  const elapsed = input.elapsedMs ?? 0;

  if (attempt >= policy.maxAttempts) {
    return { delayMs: null, exhaustedReason: "max-attempts" };
  }
  if (policy.maxDurationMs != null && elapsed >= policy.maxDurationMs) {
    return { delayMs: null, exhaustedReason: "max-duration" };
  }

  let delay: number;
  if (input.retryAfterMs != null && input.retryAfterMs >= 0) {
    // Honour Retry-After verbatim; it is NOT clamped to cap (a server that says
    // "wait 5 minutes" means it). This mirrors the Anthropic SDK behaviour.
    delay = input.retryAfterMs;
  } else {
    const ceiling = exponentialCeiling(policy, attempt);
    delay = Math.floor(rng() * ceiling); // Full Jitter: uniform in [0, ceiling)
  }

  // Never overrun the duration budget: clip the final sleep so the schedule ends on time.
  if (policy.maxDurationMs != null) {
    const remaining = policy.maxDurationMs - elapsed;
    if (remaining <= 0) return { delayMs: null, exhaustedReason: "max-duration" };
    delay = Math.min(delay, remaining);
  }

  return { delayMs: delay };
}

/** Sleep helper that resolves after ms; unref'd so it never keeps the process alive alone. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && "unref" in t) (t as { unref: () => void }).unref();
  });
}
