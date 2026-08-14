/**
 * Summariser evals.
 *
 * This is the only part of lifeline that spends money, so the properties worth proving are the
 * ones that stop it: an unchanged run must not produce a call, and a failed or nonsense reply
 * must leave the previous summary standing rather than blanking the row. No test here may reach
 * the network — the model is injected, and a test that forgets to inject one fails loudly.
 */

import { describe, expect, it } from "vitest";
import type { SummaryConfig } from "../../src/shared/config.js";
import { DEFAULT_CONFIG } from "../../src/shared/config.js";
import type { CachedSummary, SummaryInput } from "../../src/daemon/summariser.js";
import {
  buildInput,
  inputHash,
  parseSummary,
  renderPrompt,
  shouldSummarise,
  summariseRun,
} from "../../src/daemon/summariser.js";

const cfg = (over: Partial<SummaryConfig> = {}): SummaryConfig => ({
  ...DEFAULT_CONFIG.summaries,
  enabled: true,
  ...over,
});

const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  runId: "wf_1",
  workflowName: "ship-fleet",
  workspace: "claude-lifeline",
  agents: [{ agentId: "a1", item: "DIO-1", state: "running", tail: ["writing the tests"] }],
  ...over,
});

const GOOD = JSON.stringify({
  title: "Portal contract sweep",
  state: "working",
  stateLine: "waiting on 3 tasks",
  agentActivity: { a1: "rewriting the auth tests" },
});

describe("buildInput trims what leaves the machine", () => {
  it("keeps only the newest maxMessages lines per agent", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const out = buildInput(input({ agents: [{ agentId: "a1", item: null, state: "running", tail: lines }] }), cfg({ maxMessages: 5 }));
    expect(out.agents[0]?.tail).toEqual(["line 35", "line 36", "line 37", "line 38", "line 39"]);
  });

  it("honours the total character cap", () => {
    const big = Array.from({ length: 10 }, () => "x".repeat(100));
    const out = buildInput(
      input({ agents: [{ agentId: "a1", item: null, state: "running", tail: big }] }),
      cfg({ maxInputChars: 250, maxMessages: 100 }),
    );
    const total = out.agents.flatMap((a) => a.tail).join("").length;
    expect(total).toBeLessThanOrEqual(250);
  });

  it("spends its budget on the agents that moved most recently", () => {
    const agents = ["old", "new"].map((id) => ({
      agentId: id, item: null, state: "running", tail: ["y".repeat(200)],
    }));
    const out = buildInput(input({ agents }), cfg({ maxInputChars: 220, maxMessages: 10 }));
    expect(out.agents.find((a) => a.agentId === "new")?.tail.length).toBe(1);
  });

  it("drops blank lines rather than paying for them", () => {
    const out = buildInput(
      input({ agents: [{ agentId: "a1", item: null, state: "running", tail: ["  ", "real", ""] }] }),
      cfg(),
    );
    expect(out.agents[0]?.tail).toEqual(["real"]);
  });
});

describe("inputHash is the thing that stops repeat spending", () => {
  it("is stable for identical content", () => {
    expect(inputHash(buildInput(input(), cfg()))).toBe(inputHash(buildInput(input(), cfg())));
  });

  it("changes when an agent produces new output", () => {
    const b = input({ agents: [{ agentId: "a1", item: "DIO-1", state: "running", tail: ["something else"] }] });
    expect(inputHash(buildInput(input(), cfg()))).not.toBe(inputHash(buildInput(b, cfg())));
  });

  it("changes when an agent's STATE changes but its output does not", () => {
    // An agent going running -> failed writes no new tail line, and yet the summary is now wrong.
    const failed = input({ agents: [{ agentId: "a1", item: "DIO-1", state: "failed-terminal", tail: ["writing the tests"] }] });
    expect(inputHash(buildInput(input(), cfg()))).not.toBe(inputHash(buildInput(failed, cfg())));
  });
});

describe("shouldSummarise", () => {
  const cached = (over: Partial<CachedSummary> = {}): CachedSummary => ({
    hash: "h", at: 1_000, result: { title: "t", state: "working", stateLine: "s", agentActivity: {} }, ...over,
  });

  it("never calls when the feature is off", () => {
    expect(shouldSummarise(null, "h", 0, cfg({ enabled: false }))).toBe(false);
  });

  it("calls when there is nothing cached", () => {
    expect(shouldSummarise(null, "h", 0, cfg())).toBe(true);
  });

  it("does NOT call when the content is unchanged — a thinking agent is free", () => {
    expect(shouldSummarise(cached(), "h", 9_999_999, cfg())).toBe(false);
  });

  it("holds off until the minimum interval has passed, even on new content", () => {
    expect(shouldSummarise(cached(), "different", 1_100, cfg({ minIntervalMs: 30_000 }))).toBe(false);
    expect(shouldSummarise(cached(), "different", 40_000, cfg({ minIntervalMs: 30_000 }))).toBe(true);
  });
});

describe("parseSummary refuses what it cannot use", () => {
  it("reads a clean object", () => {
    expect(parseSummary(GOOD, ["a1"])?.title).toBe("Portal contract sweep");
  });

  it("survives a code fence and surrounding prose", () => {
    expect(parseSummary("Sure!\n```json\n" + GOOD + "\n```\n", ["a1"])?.state).toBe("working");
  });

  it("drops activity for an agent id that was never sent", () => {
    const out = parseSummary(GOOD, ["somebody-else"]);
    expect(out?.agentActivity).toEqual({});
  });

  it("rejects an unknown state rather than showing it", () => {
    expect(parseSummary(JSON.stringify({ title: "t", state: "vibing", stateLine: "s" }), ["a1"])).toBeNull();
  });

  it("rejects a missing title or state line", () => {
    expect(parseSummary(JSON.stringify({ state: "working", stateLine: "s" }), ["a1"])).toBeNull();
    expect(parseSummary(JSON.stringify({ title: "t", state: "working" }), ["a1"])).toBeNull();
  });

  it("rejects prose with no object at all", () => {
    expect(parseSummary("I could not summarise that.", ["a1"])).toBeNull();
  });
});

describe("renderPrompt", () => {
  it("names every agent it wants activity for", () => {
    const prompt = renderPrompt(buildInput(input(), cfg()));
    expect(prompt).toContain("a1");
    expect(prompt).toContain("writing the tests");
  });
});

describe("summariseRun", () => {
  function harness(over: { cached?: CachedSummary | null; reply?: string; fail?: boolean } = {}) {
    let calls = 0;
    const saved: CachedSummary[] = [];
    const inFlight = new Map<string, Promise<ReturnType<typeof parseSummary>>>();
    const failedAttempts = new Map<string, { at: number }>();
    const deps = {
      now: () => 1_000_000,
      load: () => over.cached ?? null,
      save: (_: string, e: CachedSummary) => void saved.push(e),
      inFlight,
      failedAttempts,
      runModel: async () => {
        calls += 1;
        if (over.fail) throw new Error("model exploded");
        return over.reply ?? GOOD;
      },
    };
    return { deps, saved, failedAttempts, calls: () => calls };
  }

  it("calls the model and caches the result", async () => {
    const h = harness();
    const out = await summariseRun(input(), cfg(), h.deps);
    expect(out?.title).toBe("Portal contract sweep");
    expect(h.calls()).toBe(1);
    expect(h.saved).toHaveLength(1);
  });

  it("spends nothing when the content has not changed", async () => {
    const hash = inputHash(buildInput(input(), cfg()));
    const h = harness({ cached: { hash, at: 0, result: { title: "old", state: "working", stateLine: "s", agentActivity: {} } } });
    const out = await summariseRun(input(), cfg(), h.deps);
    expect(h.calls()).toBe(0);
    expect(out?.title).toBe("old");
  });

  it("keeps the previous summary when the call fails", async () => {
    const prev: CachedSummary = { hash: "stale", at: 0, result: { title: "old", state: "working", stateLine: "s", agentActivity: {} } };
    const h = harness({ cached: prev, fail: true });
    const out = await summariseRun(input(), cfg(), h.deps);
    expect(out?.title).toBe("old");
    expect(h.saved).toHaveLength(0);
    expect(h.failedAttempts.size).toBe(1);
  });

  it("keeps the previous summary when the reply is unusable", async () => {
    const prev: CachedSummary = { hash: "stale", at: 0, result: { title: "old", state: "working", stateLine: "s", agentActivity: {} } };
    const h = harness({ cached: prev, reply: "no idea, sorry" });
    expect((await summariseRun(input(), cfg(), h.deps))?.title).toBe("old");
    expect(h.saved).toHaveLength(0);
    expect(h.failedAttempts.size).toBe(1);
  });

  it("never throws when everything fails and there is nothing cached", async () => {
    const h = harness({ fail: true });
    await expect(summariseRun(input(), cfg(), h.deps)).resolves.toBeNull();
  });

  it("coalesces concurrent refreshes for the same run", async () => {
    let calls = 0;
    let settle: ((value: string) => void) | undefined;
    const inFlight = new Map<string, Promise<ReturnType<typeof parseSummary>>>();
    const pending = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const deps = {
      now: () => 1_000_000,
      load: () => null,
      save: () => undefined,
      inFlight,
      failedAttempts: new Map<string, { at: number }>(),
      runModel: async () => {
        calls += 1;
        return pending;
      },
    };

    const first = summariseRun(input(), cfg(), deps);
    const second = summariseRun(input(), cfg(), deps);
    expect(calls).toBe(1);
    settle?.(GOOD);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("throttles a failed summary before starting another paid request", async () => {
    let current = 1_000_000;
    let calls = 0;
    const failedAttempts = new Map<string, { at: number }>();
    const deps = {
      now: () => current,
      load: () => null,
      save: () => undefined,
      inFlight: new Map<string, Promise<ReturnType<typeof parseSummary>>>(),
      failedAttempts,
      runModel: async () => {
        calls += 1;
        throw new Error("upstream unavailable");
      },
    };
    const policy = cfg({ minIntervalMs: 30_000 });

    await summariseRun(input(), policy, deps);
    current += 1_000;
    await summariseRun(input(), policy, deps);
    expect(calls).toBe(1);
    current += 30_000;
    await summariseRun(input(), policy, deps);
    expect(calls).toBe(2);
  });

  it("makes no call at all while the feature is off", async () => {
    const h = harness();
    await summariseRun(input(), cfg({ enabled: false }), h.deps);
    expect(h.calls()).toBe(0);
  });
});
