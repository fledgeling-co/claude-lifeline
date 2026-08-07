import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverActiveRunDirs, runDirOf } from "../../src/daemon/index.js";

/**
 * The EMFILE regression guard: discovery must find recently-touched run dirs by mtime
 * without opening a watch handle per directory, and must skip a large static history.
 */
describe("discoverActiveRunDirs", () => {
  let base: string | null = null;
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = null;
  });

  function mkRun(root: string, project: string, session: string, runId: string): string {
    const dir = join(root, project, session, "subagents", "workflows", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), "{}\n");
    return dir;
  }

  function ageDir(dir: string, ageMs: number): void {
    // Age the directory AND its ancestors up to base so the mtime gate prunes them.
    const when = (Date.now() - ageMs) / 1000;
    let cur = dir;
    for (let i = 0; i < 6; i++) {
      try {
        utimesSync(cur, when, when);
      } catch {
        /* ignore */
      }
      cur = join(cur, "..");
    }
  }

  it("finds a freshly-touched run dir and ignores an aged one", () => {
    base = mkdtempSync(join(tmpdir(), "lifeline-disc-"));
    const now = Date.now();
    const fresh = mkRun(base, "p-live", "s1", "wf_live");
    const old = mkRun(base, "p-old", "s2", "wf_old");
    ageDir(old, 10 * 60_000); // 10 minutes old, whole branch

    const found = discoverActiveRunDirs(base, 60_000, now);
    expect(found).toContain(fresh);
    expect(found).not.toContain(old);
  });

  it("skips a project whose top-level mtime is outside the window without descending", () => {
    base = mkdtempSync(join(tmpdir(), "lifeline-disc-"));
    // Many aged projects (stand-in for 12k historical dirs) + one live one.
    for (let i = 0; i < 20; i++) {
      const d = mkRun(base, `p-hist-${i}`, "s", `wf_${i}`);
      ageDir(d, 60 * 60_000);
    }
    const live = mkRun(base, "p-live", "s", "wf_now");
    const found = discoverActiveRunDirs(base, 60_000, Date.now());
    expect(found).toEqual([live]);
  });

  it("returns [] for a missing base rather than throwing", () => {
    expect(discoverActiveRunDirs(join(tmpdir(), "does-not-exist-lifeline"), 60_000, Date.now())).toEqual([]);
  });

  it("runDirOf still maps a file path back to its wf_ dir", () => {
    const b = "/b";
    expect(runDirOf(b, "/b/proj/sess/subagents/workflows/wf_x/journal.jsonl")).toBe(
      "/b/proj/sess/subagents/workflows/wf_x",
    );
    expect(runDirOf(b, "/b/proj/sess/other/file")).toBeNull();
  });
});
