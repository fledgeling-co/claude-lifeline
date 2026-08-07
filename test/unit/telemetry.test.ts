import { describe, it, expect } from "vitest";
import {
  contextFracFromUsage,
  readTelemetry,
  readCallerTail,
  scanRunDir,
} from "../../src/daemon/journal.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
function assistant(text: string, tsMs: number, usage?: Record<string, number>, model = "claude-opus-4"): Record<string, unknown> {
  return {
    type: "assistant",
    cwd: "/repo",
    timestamp: new Date(tsMs).toISOString(),
    message: { model, content: [{ type: "text", text }], ...(usage ? { usage } : {}) },
  };
}

describe("contextFracFromUsage", () => {
  it("sums the prompt tokens and divides by the 200k default", () => {
    const frac = contextFracFromUsage(
      { input_tokens: 2, cache_creation_input_tokens: 2514, cache_read_input_tokens: 41901 },
      "claude-opus-4",
      200_000,
    );
    expect(frac).toBeCloseTo((2 + 2514 + 41901) / 200_000, 5);
  });
  it("uses the 1m window for [1m] models", () => {
    const frac = contextFracFromUsage({ cache_read_input_tokens: 500_000 }, "claude-fable-5[1m]", 200_000);
    expect(frac).toBeCloseTo(0.5, 5);
  });
  it("caps at 1 and returns null when nothing was used", () => {
    expect(contextFracFromUsage({ cache_read_input_tokens: 999_999_999 }, "m", 200_000)).toBe(1);
    expect(contextFracFromUsage({}, "m", 200_000)).toBeNull();
  });
});

describe("readTelemetry", () => {
  it("derives first/last timestamps, latest context fill, and the tail", () => {
    const head = jsonl([assistant("Starting", 1000)]);
    const tail = jsonl([
      assistant("Editing ledger.ts", 61_000, { input_tokens: 10, cache_read_input_tokens: 90_000 }),
      assistant("Running vitest", 121_000, { input_tokens: 10, cache_read_input_tokens: 120_000 }),
    ]);
    const t = readTelemetry(head, tail, 200_000, 2);
    expect(t.firstTsMs).toBe(1000);
    expect(t.lastTsMs).toBe(121_000);
    expect(t.contextFrac).toBeCloseTo(120_010 / 200_000, 4);
    expect(t.tail).toEqual(["Editing ledger.ts", "Running vitest"]);
  });
});

describe("scanRunDir — telemetry, caller tail, and stall detection", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function layout(): { runDir: string; sessionDir: string } {
    root = mkdtempSync(join(tmpdir(), "lifeline-tele-"));
    const sessionDir = join(root, "-repo", "sess-uuid");
    const runDir = join(sessionDir, "subagents", "workflows", "wf_tele");
    mkdirSync(runDir, { recursive: true });
    // caller session transcript sits at <project>/<sessionId>.jsonl (sibling to the dir)
    writeFileSync(
      `${sessionDir}.jsonl`,
      jsonl([assistant("Kicked off the fleet", 500), assistant("Waiting on the verify gate", 1500)]),
    );
    return { runDir, sessionDir };
  }

  it("surfaces per-agent duration/context/tail, the caller tail, and flags a stalled agent", () => {
    const { runDir } = layout();
    const now = 1_000_000_000;
    // healthy agent
    writeFileSync(
      join(runDir, "journal.jsonl"),
      jsonl([
        { type: "started", key: "a".repeat(64), agentId: "a1" },
        { type: "started", key: "c".repeat(64), agentId: "a2" },
      ]),
    );
    writeFileSync(
      join(runDir, "agent-a1.jsonl"),
      jsonl([
        assistant("Starting LL-1", now - 300_000),
        assistant("Editing src/x.ts", now - 60_000, { input_tokens: 5, cache_read_input_tokens: 100_000 }),
      ]),
    );
    // stalled agent: last activity 12 minutes ago, no error, no result
    const stalledAgent = join(runDir, "agent-a2.jsonl");
    writeFileSync(
      stalledAgent,
      jsonl([assistant("Starting LL-2", now - 1_200_000), assistant("Editing src/y.ts", now - 720_000)]),
    );

    const scan = scanRunDir(runDir, {
      now,
      liveWindowMs: 5_000_000, // large, so the stalled one isn't mistaken for a live-window loss
      stallWindowMs: 600_000, // 10 min
      contextLimitTokens: 200_000,
    });
    expect(scan).not.toBeNull();
    expect(scan!.callerTail).toEqual(["Kicked off the fleet", "Waiting on the verify gate"]);

    const a1 = scan!.agents.find((a) => a.agentId === "a1")!;
    expect(a1.kind).toBe("live");
    expect(a1.durationMs).toBe(240_000);
    expect(a1.contextFrac).toBeCloseTo(100_005 / 200_000, 4);
    expect(a1.tail.at(-1)).toBe("Editing src/x.ts");

    const a2 = scan!.agents.find((a) => a.agentId === "a2")!;
    expect(a2.kind).toBe("stalled");
    expect(scan!.stalled.map((s) => s.agentId)).toContain("a2");
    expect(a2.quietForMs).toBeGreaterThanOrEqual(700_000);
  });

  it("does not flag a recently-active agent as stalled", () => {
    const { runDir } = layout();
    const now = 1_000_000_000;
    writeFileSync(join(runDir, "journal.jsonl"), jsonl([{ type: "started", key: "b".repeat(64), agentId: "b1" }]));
    writeFileSync(join(runDir, "agent-b1.jsonl"), jsonl([assistant("Working", now - 30_000)]));
    const scan = scanRunDir(runDir, { now, liveWindowMs: 300_000, stallWindowMs: 600_000, contextLimitTokens: 200_000 });
    expect(scan!.stalled).toHaveLength(0);
    expect(scan!.agents.find((a) => a.agentId === "b1")!.kind).toBe("live");
  });
});
