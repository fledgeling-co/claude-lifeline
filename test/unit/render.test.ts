/**
 * Render evals — the state VOCABULARY the spec's acceptance criteria are written against.
 *
 * The load-bearing assertion is criterion 4: a run with one failed-but-recovering agent must
 * read as a run-level WARNING (or `completed with failures`), never as an error. That
 * distinction is the whole point of lifeline's status surface — the built-in TUI paints a red
 * cross and the run still reports "completed".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/shared/backoff.js";
import type { AgentState, RunState, StatusAgent, StatusRun, StatusSnapshot } from "../../src/shared/types.js";
import type { DoctorReport } from "../../src/cli/commands.js";
import {
  agentLabel,
  colorEnabled,
  countAgents,
  formatAgentState,
  formatDuration,
  formatRelative,
  formatRunState,
  renderDoctor,
  renderStatus,
} from "../../src/cli/render.js";

const NOW = 1_700_000_000_000;

function agent(over: Partial<StatusAgent> = {}): StatusAgent {
  return {
    agentId: "a1",
    item: "LL-0001",
    state: "retrying",
    attempts: 3,
    maxAttempts: 30,
    nextRetryAt: NOW + 12_000,
    lastClass: "RATE_LIMIT",
    ...over,
  };
}

function run(over: Partial<StatusRun> = {}): StatusRun {
  return {
    runId: "wf_alpha",
    project: "-Users-luke-Dev-lifeline",
    state: "warning",
    agents: [agent()],
    ...over,
  };
}

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return { updatedAt: NOW, online: true, runs: [run()], ...over };
}

/** True when the string carries an ANSI SGR escape (ESC + '['), not merely a bracket. */
const hasAnsi = (s: string): boolean => s.includes("\u001b[");

describe("formatAgentState — per-agent vocabulary", () => {
  it("shows retrying with the attempt fraction and the countdown", () => {
    expect(formatAgentState(agent({ attempts: 3, maxAttempts: 30, nextRetryAt: NOW + 12_000 }), NOW)).toBe(
      "retrying (3/30, next in 12s)",
    );
  });

  it("says 'due now' rather than a negative countdown", () => {
    expect(formatAgentState(agent({ nextRetryAt: NOW - 5_000 }), NOW)).toBe("retrying (3/30, due now)");
    expect(formatAgentState(agent({ nextRetryAt: NOW }), NOW)).toBe("retrying (3/30, due now)");
  });

  it("omits the countdown when nothing is scheduled", () => {
    expect(formatAgentState(agent({ nextRetryAt: null }), NOW)).toBe("retrying (3/30)");
  });

  it("falls back to the shipped attempt cap when the snapshot carries none", () => {
    expect(formatAgentState(agent({ maxAttempts: 0, nextRetryAt: null }), NOW)).toBe(
      `retrying (3/${DEFAULT_POLICY.maxAttempts})`,
    );
  });

  it.each([
    ["paused-offline", "paused (offline)"],
    ["paused-usage-limit", "paused (usage limit)"],
    ["paused-manual", "paused"],
    ["failed-terminal", "failed"],
    ["done", "done"],
  ] as [AgentState, string][])("%s renders as %s", (state, expected) => {
    expect(formatAgentState(agent({ state }), NOW)).toBe(expected);
  });
});

describe("formatRunState — run-level vocabulary", () => {
  it.each([
    ["running", "running"],
    ["completed", "completed"],
    ["completed-with-failures", "completed with failures"],
    ["warning", "warning"],
    ["recovering", "recovering"],
  ] as [RunState, string][])("%s renders as %s", (state, expected) => {
    expect(formatRunState(state)).toBe(expected);
  });

  it("keeps `completed with failures` distinct from `completed`", () => {
    expect(formatRunState("completed-with-failures")).not.toBe(formatRunState("completed"));
  });
});

describe("renderStatus — a failed-but-recovering agent is a run-level warning, not an error", () => {
  const opts = { color: false, now: NOW } as const;

  it("renders the run as `warning` while siblings still run", () => {
    const out = renderStatus(
      snapshot({
        runs: [
          run({
            state: "warning",
            agents: [
              agent({ agentId: "a1", item: "LL-0001", state: "retrying" }),
              agent({ agentId: "a2", item: "LL-0002", state: "done", lastClass: null, nextRetryAt: null }),
            ],
          }),
        ],
      }),
      opts,
    );

    expect(out).toContain("warning");
    expect(out).toContain("wf_alpha");
    expect(out).toContain("retrying (3/30, next in 12s)");
    // The load-bearing negative: nothing in this render calls the run an error.
    expect(out).not.toMatch(/\berror\b/i);
  });

  it("renders a finished run that lost an agent as `completed with failures`, not an error", () => {
    const out = renderStatus(
      snapshot({
        runs: [
          run({
            state: "completed-with-failures",
            agents: [
              agent({ agentId: "a1", item: "LL-0001", state: "failed-terminal", lastClass: "CONTEXT", nextRetryAt: null }),
              agent({ agentId: "a2", item: "LL-0002", state: "done", lastClass: null, nextRetryAt: null }),
            ],
          }),
        ],
      }),
      opts,
    );

    expect(out).toContain("completed with failures");
    expect(out).not.toMatch(/\berror\b/i);
    // The agent itself is still reported as failed — the reframing is at run level only.
    expect(out).toContain("failed");
    expect(out).toContain("CONTEXT");
  });

  it("summarises the fleet at the foot of the block", () => {
    const out = renderStatus(
      snapshot({
        runs: [
          run({
            agents: [
              agent({ state: "retrying" }),
              agent({ state: "paused-usage-limit" }),
              agent({ state: "failed-terminal" }),
              agent({ state: "done" }),
            ],
          }),
        ],
      }),
      opts,
    );
    expect(out).toContain("1 run · 4 agents · 1 retrying · 1 paused · 1 failed");
  });

  it("shows connectivity and staleness", () => {
    expect(renderStatus(snapshot({ online: false }), opts)).toContain("offline");
    expect(renderStatus(snapshot({ online: true }), opts)).toContain("online");
    const stale = renderStatus(snapshot({ updatedAt: NOW - 120_000 }), { ...opts, staleAfterMs: 60_000 });
    expect(stale).toContain("(stale)");
  });

  it("explains an absent snapshot instead of rendering an empty block", () => {
    const out = renderStatus(null, opts);
    expect(out).toContain("no status yet");
    expect(out).toContain("lifeline doctor");
  });

  it("says so when there are no runs", () => {
    expect(renderStatus(snapshot({ runs: [] }), opts)).toContain("No runs tracked.");
  });

  it("shows the agent id alongside a human item so the retry handle is typeable", () => {
    const out = renderStatus(snapshot(), opts);
    expect(out).toContain("LL-0001");
    expect(out).toContain("[a1]");
  });

  it("never leaves trailing whitespace on a line", () => {
    const out = renderStatus(
      snapshot({
        runs: [
          run({
            agents: [
              agent({ item: "LL-0001", state: "done", lastClass: null, nextRetryAt: null }),
              agent({ item: "A-VERY-LONG-ITEM-0002", state: "retrying" }),
            ],
          }),
        ],
      }),
      opts,
    );
    for (const line of out.split("\n")) expect(line).toBe(line.trimEnd());
  });
});

describe("colour", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.TERM;
  });

  afterEach(() => {
    for (const key of ["NO_COLOR", "FORCE_COLOR", "TERM"]) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("colorEnabled honours NO_COLOR over the TTY check", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "anything" }, true)).toBe(false);
    // no-color.org: an EMPTY NO_COLOR does not disable colour.
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true);
  });

  it("colorEnabled honours FORCE_COLOR for piped output", () => {
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, false)).toBe(false);
  });

  it("colorEnabled refuses a dumb terminal", () => {
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false);
  });

  it("NO_COLOR strips every escape from renderStatus", () => {
    process.env.NO_COLOR = "1";
    const out = renderStatus(snapshot(), { now: NOW });
    expect(hasAnsi(out)).toBe(false);
    expect(out).toContain("warning");
  });

  it("FORCE_COLOR paints renderStatus even without a TTY", () => {
    process.env.FORCE_COLOR = "1";
    expect(hasAnsi(renderStatus(snapshot(), { now: NOW }))).toBe(true);
  });

  it("NO_COLOR beats FORCE_COLOR", () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    expect(hasAnsi(renderStatus(snapshot(), { now: NOW }))).toBe(false);
  });

  it("NO_COLOR strips every escape from renderDoctor too", () => {
    process.env.NO_COLOR = "1";
    const report: DoctorReport = {
      checks: [
        { id: "gateway", label: "gateway", level: "ok", detail: "responded" },
        { id: "daemon", label: "daemon", level: "fail", detail: "not running" },
      ],
      ok: false,
      hardFailure: true,
    };
    const out = renderDoctor(report);
    expect(hasAnsi(out)).toBe(false);
    expect(out).toContain("gateway");
    expect(out).toContain("Not healthy");
  });

  it("an explicit color option overrides the environment either way", () => {
    process.env.NO_COLOR = "1";
    expect(hasAnsi(renderStatus(snapshot(), { now: NOW, color: true }))).toBe(true);
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(hasAnsi(renderStatus(snapshot(), { now: NOW, color: false }))).toBe(false);
  });
});

describe("renderDoctor", () => {
  const base = (over: Partial<DoctorReport> = {}): DoctorReport => ({
    checks: [{ id: "gateway", label: "gateway", level: "ok", detail: "responded" }],
    ok: true,
    hardFailure: false,
    ...over,
  });

  it("reports all green", () => {
    expect(renderDoctor(base(), { color: false })).toContain("All green.");
  });

  it("distinguishes warnings from failures", () => {
    const warned = renderDoctor(
      base({
        checks: [{ id: "api-key", label: "ANTHROPIC_API_KEY", level: "warn", detail: "set" }],
        ok: false,
      }),
      { color: false },
    );
    expect(warned).toContain("Healthy, with warnings.");
    expect(warned).toContain("warn");

    const failed = renderDoctor(
      base({
        checks: [{ id: "daemon", label: "daemon", level: "fail", detail: "not running" }],
        ok: false,
        hardFailure: true,
      }),
      { color: false },
    );
    expect(failed).toContain("Not healthy");
  });
});

describe("counts and labels", () => {
  it("countAgents buckets every state", () => {
    const counts = countAgents([
      run({
        agents: [
          agent({ state: "retrying" }),
          agent({ state: "paused-offline" }),
          agent({ state: "paused-usage-limit" }),
          agent({ state: "paused-manual" }),
          agent({ state: "failed-terminal" }),
          agent({ state: "done" }),
        ],
      }),
    ]);
    expect(counts).toEqual({ total: 6, retrying: 1, paused: 3, failed: 1, done: 1 });
  });

  it("agentLabel prefers the human item, then the agent id, then a placeholder", () => {
    expect(agentLabel(agent({ item: "LL-0007", agentId: "a9" }))).toBe("LL-0007");
    expect(agentLabel(agent({ item: null, agentId: "a9" }))).toBe("a9");
    expect(agentLabel(agent({ item: null, agentId: null }))).toBe("(unnamed)");
  });
});

describe("durations", () => {
  it("formats coarsely and never negatively", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5_000)).toBe("0s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(130_000)).toBe("2m 10s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("formats relative times in both directions", () => {
    expect(formatRelative(NOW, NOW)).toBe("just now");
    expect(formatRelative(NOW - 3_000, NOW)).toBe("3s ago");
    expect(formatRelative(NOW + 12_000, NOW)).toBe("in 12s");
  });
});
