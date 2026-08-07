/**
 * Menu-bar app contract evals — spec acceptance criteria 3, 4 and the vocabulary-drift
 * guard. The Swift app is a thin view over two file contracts (status.json in,
 * ControlIntent files out); these tests pin both sides from the TypeScript end:
 *
 *  1. An intent file in EXACTLY the shape the Swift app writes is honoured by the real
 *     daemon (pause -> paused-manual, resume -> back to scheduled recovery).
 *  2. Every AgentState/RunState string in types.ts appears in the Swift source's
 *     switches, and every state string the Swift source switches on exists in types.ts —
 *     so a rename on either side fails a test instead of silently rendering wrong.
 *
 * The Swift binary itself is typechecked by `swiftc -typecheck` (CI + install); pixels
 * are out of scope here by design.
 */

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/shared/config.js";
import type { LifelineConfig } from "../../src/shared/config.js";
import { paths } from "../../src/shared/paths.js";
import { startDaemon } from "../../src/daemon/index.js";
import { getEntry, loadLedger } from "../../src/daemon/ledger.js";
import type { SpawnFn } from "../../src/daemon/recovery.js";
import { useTempEnv } from "../support/tmp.js";

const PROJECT = "-Users-luke-Dev-sample";
const SESSION = "9f1c2b7d-0000-4000-8000-00000000abcd";
const RUN_ID = "wf_menubar01";
const KEY = "f".repeat(64);

const RATE_LIMIT_TAIL =
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your limit"}}';

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Lay down one run with one lost (rate-limited) agent, exactly as Claude Code does. */
function synthesiseRun(projects: string): string {
  const runDir = join(projects, PROJECT, SESSION, "subagents", "workflows", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "journal.jsonl"), jsonl([{ type: "started", key: KEY, agentId: "agent1" }]));
  writeFileSync(
    join(runDir, "agent-agent1.jsonl"),
    jsonl([
      { type: "assistant", cwd: "/tmp/x", message: { content: [{ type: "text", text: "working on ML-0001" }] } },
      {
        type: "assistant",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: { model: "<synthetic>", content: [{ type: "text", text: RATE_LIMIT_TAIL }] },
      },
    ]),
  );
  const snapDir = join(projects, PROJECT, SESSION, "workflows");
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, `${RUN_ID}.json`), JSON.stringify({ scriptPath: "/tmp/x/wf.js", args: null }));
  // Backdate the transcripts so the agent is unambiguously outside the live window —
  // at millisecond resolution a same-tick write has age 0 and the lost-check is racy.
  const past = (Date.now() - 60_000) / 1000;
  for (const f of ["journal.jsonl", "agent-agent1.jsonl"]) {
    utimesSync(join(runDir, f), past, past);
  }
  return runDir;
}

/**
 * An intent file with byte-shape parity to Lifeline.writeIntent in the Swift source:
 * pretty-printed, sorted keys, timestamp-first filename.
 */
function writeSwiftShapedIntent(kind: string, runId: string, agentId: string | null): string {
  const createdAt = Date.now();
  const id = "0f9d1c2b-1111-4222-8333-444455556666";
  const intent = { createdAt, id, kind, target: { agentId, runId } };
  mkdirSync(paths.intentsDir(), { recursive: true });
  const file = join(paths.intentsDir(), `${createdAt}-${id}.json`);
  // Plain stringify: a replacer ARRAY would filter nested target keys out entirely.
  // (Swift's JSONEncoder .sortedKeys orders keys; it never drops them.)
  writeFileSync(file, JSON.stringify(intent, null, 2));
  return file;
}

const cfg: LifelineConfig = {
  ...DEFAULT_CONFIG,
  liveWindowMs: 0, // everything on disk is immediately "not live" for the scan
  daemonTickMs: 1_000_000,
};

describe("menubar contract — intents written by the Swift app drive the real daemon", () => {
  const tmp = useTempEnv();

  it("pause (run-scoped, no agentId) parks the entry; resume re-arms it", async () => {
    synthesiseRun(tmp.env.projects);
    const spawned: string[][] = [];
    const spawn: SpawnFn = (cmd, args) => {
      spawned.push([cmd, ...args]);
      return { unref() {} } as ReturnType<SpawnFn>;
    };
    const daemon = startDaemon(cfg, { watch: false, relaunch: { spawn } });
    try {
      await daemon.tick(); // discovery is off (watch:false); mark + ingest
      daemon.markDirty(join(tmp.env.projects, PROJECT, SESSION, "subagents", "workflows", RUN_ID));
      await daemon.tick();
      const before = getEntry(loadLedger(RUN_ID), KEY);
      expect(before?.state).toBe("retrying");

      writeSwiftShapedIntent("pause", RUN_ID, null); // run-scoped: agentId null
      await daemon.tick();
      expect(getEntry(loadLedger(RUN_ID), KEY)?.state).toBe("paused-manual");

      writeSwiftShapedIntent("resume", RUN_ID, null);
      await daemon.tick();
      const after = getEntry(loadLedger(RUN_ID), KEY);
      expect(after?.state).toBe("retrying");
    } finally {
      await daemon.stop();
    }
  });

  it("retry with an agentId targets without error and stays idempotent", async () => {
    synthesiseRun(tmp.env.projects);
    const daemon = startDaemon(cfg, {
      watch: false,
      relaunch: { spawn: (() => ({ unref() {} })) as unknown as SpawnFn },
    });
    try {
      daemon.markDirty(join(tmp.env.projects, PROJECT, SESSION, "subagents", "workflows", RUN_ID));
      await daemon.tick();
      writeSwiftShapedIntent("retry", RUN_ID, "agent1");
      await daemon.tick();
      writeSwiftShapedIntent("retry", RUN_ID, "agent1"); // pressing again is a no-op, not an error
      await daemon.tick();
      const entry = getEntry(loadLedger(RUN_ID), KEY);
      expect(entry).not.toBeNull();
      expect(entry?.state).not.toBe("failed-terminal");
    } finally {
      await daemon.stop();
    }
  });
});

describe("menubar contract — state vocabulary stays in sync with the Swift source", () => {
  const typesSource = readFileSync(join(process.cwd(), "src/shared/types.ts"), "utf8");
  const swiftSource = readFileSync(join(process.cwd(), "menubar/lifeline-menubar.swift"), "utf8");

  function unionMembers(name: string): string[] {
    const m = new RegExp(`export type ${name} =([^;]+);`, "s").exec(typesSource);
    if (!m) throw new Error(`type ${name} not found in types.ts`);
    return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  }

  it("every AgentState in types.ts is handled by the Swift switches", () => {
    for (const state of unionMembers("AgentState")) {
      expect(swiftSource, `AgentState "${state}" missing from Swift source`).toContain(`"${state}"`);
    }
  });

  it("every RunState in types.ts is handled by the Swift switches", () => {
    for (const state of unionMembers("RunState")) {
      expect(swiftSource, `RunState "${state}" missing from Swift source`).toContain(`"${state}"`);
    }
  });

  it("every state literal the Swift source switches on exists in types.ts", () => {
    const known = new Set([...unionMembers("AgentState"), ...unionMembers("RunState")]);
    // Case-pattern literals in the two Vocab switches + health rollup.
    const swiftCases = [...swiftSource.matchAll(/case "([a-z-]+)"/g)].map((m) => m[1]!);
    for (const literal of swiftCases) {
      if (["retry", "pause", "resume"].includes(literal)) continue; // intent kinds, not states
      expect(known.has(literal), `Swift switches on "${literal}" which types.ts does not define`).toBe(true);
    }
  });
});
