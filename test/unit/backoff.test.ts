/**
 * Backoff evals — property-based, because the interesting failures are at the edges of the
 * attempt/elapsed space rather than at any one hand-picked value.
 *
 * The four properties are the whole contract of Full Jitter as lifeline uses it:
 *   1. a delay is always inside [0, ceiling)
 *   2. exhaustion is exactly "out of attempts" or "out of wall clock" — nothing else
 *   3. Retry-After is honoured VERBATIM, not clamped to the cap
 *   4. a fixed rng makes the whole schedule reproducible
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BackoffPolicy } from "../../src/shared/backoff.js";
import { DEFAULT_POLICY, exponentialCeiling, nextDelay, sleep } from "../../src/shared/backoff.js";

/** Policies with no wall-clock budget, so the attempt bound is the only exhaustion path. */
const unboundedPolicy = fc.record({
  baseMs: fc.integer({ min: 1, max: 5_000 }),
  capMs: fc.integer({ min: 1, max: 120_000 }),
  maxAttempts: fc.integer({ min: 1, max: 50 }),
});

/** Policies that also carry a duration budget. */
const boundedPolicy = fc.record({
  baseMs: fc.integer({ min: 1, max: 5_000 }),
  capMs: fc.integer({ min: 1, max: 120_000 }),
  maxAttempts: fc.integer({ min: 1, max: 50 }),
  maxDurationMs: fc.integer({ min: 1, max: 3_600_000 }),
});

const unitInterval = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

describe("exponentialCeiling", () => {
  it("is non-decreasing in attempt and never exceeds the cap", () => {
    fc.assert(
      fc.property(unboundedPolicy, fc.integer({ min: 0, max: 60 }), (policy, attempt) => {
        const here = exponentialCeiling(policy, attempt);
        const next = exponentialCeiling(policy, attempt + 1);
        expect(here).toBeLessThanOrEqual(policy.capMs);
        expect(next).toBeGreaterThanOrEqual(here);
        expect(Number.isFinite(here)).toBe(true);
      }),
    );
  });

  it("doubles from the base until it saturates at the cap", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 8000, maxAttempts: 30 };
    expect(exponentialCeiling(policy, 0)).toBe(1000);
    expect(exponentialCeiling(policy, 1)).toBe(2000);
    expect(exponentialCeiling(policy, 2)).toBe(4000);
    expect(exponentialCeiling(policy, 3)).toBe(8000);
    expect(exponentialCeiling(policy, 4)).toBe(8000);
    // A large attempt index must not overflow into Infinity/NaN.
    expect(exponentialCeiling(policy, 1024)).toBe(8000);
  });
});

describe("nextDelay — jitter bounds", () => {
  it("returns 0 <= delayMs < min(cap, base * 2^attempt)", () => {
    fc.assert(
      fc.property(unboundedPolicy, fc.integer({ min: 0, max: 49 }), unitInterval, (policy, rawAttempt, r) => {
        const attempt = rawAttempt % policy.maxAttempts;
        const { delayMs } = nextDelay({ policy, attempt, rng: () => r });
        const ceiling = exponentialCeiling(policy, attempt);
        expect(delayMs).not.toBeNull();
        expect(delayMs as number).toBeGreaterThanOrEqual(0);
        expect(delayMs as number).toBeLessThan(ceiling);
      }),
    );
  });

  it("holds the same bound when a duration budget is present and not yet spent", () => {
    fc.assert(
      fc.property(boundedPolicy, fc.integer({ min: 0, max: 49 }), unitInterval, (policy, rawAttempt, r) => {
        const attempt = rawAttempt % policy.maxAttempts;
        const elapsed = Math.floor(policy.maxDurationMs / 2);
        const { delayMs } = nextDelay({ policy, attempt, elapsedMs: elapsed, rng: () => r });
        expect(delayMs).not.toBeNull();
        expect(delayMs as number).toBeGreaterThanOrEqual(0);
        expect(delayMs as number).toBeLessThan(exponentialCeiling(policy, attempt));
        // The final sleep never overruns the budget.
        expect(elapsed + (delayMs as number)).toBeLessThanOrEqual(policy.maxDurationMs);
      }),
    );
  });

  it("spans the whole jitter window: rng 0 gives 0, rng just under 1 gives ceiling - 1", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 60_000, maxAttempts: 30 };
    expect(nextDelay({ policy, attempt: 3, rng: () => 0 }).delayMs).toBe(0);
    expect(nextDelay({ policy, attempt: 3, rng: () => 0.999999 }).delayMs).toBe(7999);
  });
});

describe("nextDelay — exhaustion", () => {
  it("is null exactly when attempt >= maxAttempts or elapsed >= maxDuration", () => {
    fc.assert(
      fc.property(
        boundedPolicy,
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 3_600_000 }),
        fc.option(fc.integer({ min: 0, max: 600_000 }), { nil: undefined }),
        unitInterval,
        (policy, attempt, elapsedMs, retryAfterMs, r) => {
          const { delayMs, exhaustedReason } = nextDelay({
            policy,
            attempt,
            elapsedMs,
            retryAfterMs,
            rng: () => r,
          });
          const outOfAttempts = attempt >= policy.maxAttempts;
          const outOfTime = elapsedMs >= policy.maxDurationMs;
          expect(delayMs === null).toBe(outOfAttempts || outOfTime);
          if (delayMs === null) {
            expect(exhaustedReason).toBe(outOfAttempts ? "max-attempts" : "max-duration");
          } else {
            expect(exhaustedReason).toBeUndefined();
          }
        },
      ),
    );
  });

  it("never exhausts on attempts alone when the policy has no duration budget", () => {
    fc.assert(
      fc.property(unboundedPolicy, fc.integer({ min: 0, max: 49 }), unitInterval, (policy, rawAttempt, r) => {
        const attempt = rawAttempt % policy.maxAttempts;
        expect(nextDelay({ policy, attempt, elapsedMs: 10_000_000, rng: () => r }).delayMs).not.toBeNull();
      }),
    );
  });

  it("reports max-attempts at exactly the cap (the 30th retry is the last)", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 60_000, maxAttempts: 30 };
    expect(nextDelay({ policy, attempt: 29, rng: () => 0 }).delayMs).toBe(0);
    const exhausted = nextDelay({ policy, attempt: 30, rng: () => 0 });
    expect(exhausted.delayMs).toBeNull();
    expect(exhausted.exhaustedReason).toBe("max-attempts");
  });
});

describe("nextDelay — Retry-After override", () => {
  it("honours a non-negative Retry-After verbatim, uncapped", () => {
    fc.assert(
      fc.property(
        unboundedPolicy,
        fc.integer({ min: 0, max: 49 }),
        fc.integer({ min: 0, max: 3_600_000 }),
        unitInterval,
        (policy, rawAttempt, retryAfterMs, r) => {
          const attempt = rawAttempt % policy.maxAttempts;
          const { delayMs } = nextDelay({ policy, attempt, retryAfterMs, rng: () => r });
          expect(delayMs).toBe(retryAfterMs);
        },
      ),
    );
  });

  it("does not clamp Retry-After to the cap — a server saying 'wait 5 minutes' means it", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 60_000, maxAttempts: 30 };
    expect(nextDelay({ policy, attempt: 0, retryAfterMs: 300_000, rng: () => 0.5 }).delayMs).toBe(300_000);
  });

  it("ignores a negative Retry-After and falls back to jitter", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 60_000, maxAttempts: 30 };
    const { delayMs } = nextDelay({ policy, attempt: 0, retryAfterMs: -1, rng: () => 0.5 });
    expect(delayMs).toBe(500);
  });

  it("ignores a null Retry-After and falls back to jitter", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 60_000, maxAttempts: 30 };
    expect(nextDelay({ policy, attempt: 0, retryAfterMs: null, rng: () => 0.25 }).delayMs).toBe(250);
  });

  it("still clips Retry-After to whatever budget remains", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 60_000, maxAttempts: 30, maxDurationMs: 10_000 };
    const { delayMs } = nextDelay({ policy, attempt: 0, retryAfterMs: 300_000, elapsedMs: 9_000 });
    expect(delayMs).toBe(1_000);
  });
});

describe("nextDelay — determinism", () => {
  it("a fixed rng reproduces the same delay for the same inputs", () => {
    fc.assert(
      fc.property(unboundedPolicy, fc.integer({ min: 0, max: 49 }), unitInterval, (policy, rawAttempt, r) => {
        const attempt = rawAttempt % policy.maxAttempts;
        const first = nextDelay({ policy, attempt, rng: () => r });
        const second = nextDelay({ policy, attempt, rng: () => r });
        expect(second).toEqual(first);
      }),
    );
  });

  it("a seeded sequence reproduces the whole schedule", () => {
    const policy: BackoffPolicy = { baseMs: 1000, capMs: 8_000, maxAttempts: 6 };
    const schedule = (): (number | null)[] => {
      const values = [0.1, 0.9, 0.5, 0.25, 0.75, 0.0];
      let i = 0;
      const rng = (): number => values[i++ % values.length] as number;
      return Array.from({ length: 7 }, (_, attempt) => nextDelay({ policy, attempt, rng }).delayMs);
    };
    expect(schedule()).toEqual(schedule());
    expect(schedule()).toEqual([100, 1800, 2000, 2000, 6000, 0, null]);
  });
});

describe("DEFAULT_POLICY", () => {
  it("matches the decided recovery policy: 30 attempts, 60s cap, 1h wall clock", () => {
    expect(DEFAULT_POLICY.maxAttempts).toBe(30);
    expect(DEFAULT_POLICY.capMs).toBe(60_000);
    expect(DEFAULT_POLICY.baseMs).toBe(1_000);
    expect(DEFAULT_POLICY.maxDurationMs).toBe(60 * 60 * 1000);
  });
});

describe("sleep", () => {
  it("resolves after roughly the requested delay", async () => {
    const started = Date.now();
    await sleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
