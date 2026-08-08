import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverActiveRunDirs, runDirOf } from "../../src/daemon/index.js";
import { apiErrorFromTail } from "../../src/daemon/journal.js";

/**
 * Discovery keys off the run's transcript FILE mtimes, not directory mtimes: a live
 * workflow appends to existing files and never bumps any ancestor directory's mtime, so a
 * dir-mtime scan would miss it (the bug this guards against). It also stays EMFILE-safe by
 * never holding a watch handle, and uses a wide project-mtime pre-filter to skip ancient
 * scratch dirs cheaply.
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

  function ageFiles(dir: string, ageMs: number): void {
    const when = (Date.now() - ageMs) / 1000;
    try {
      utimesSync(join(dir, "journal.jsonl"), when, when);
    } catch {
      /* ignore */
    }
  }

  it("finds a run whose journal was written recently, ignores one whose files are old", () => {
    base = mkdtempSync(join(tmpdir(), "lifeline-disc-"));
    const now = Date.now();
    const fresh = mkRun(base, "p-live", "s1", "wf_live");
    const old = mkRun(base, "p-old", "s2", "wf_old");
    ageFiles(old, 20 * 60_000); // journal last written 20 minutes ago

    const found = discoverActiveRunDirs(base, 15 * 60_000, now, 0);
    expect(found).toContain(fresh);
    expect(found).not.toContain(old);
  });

  it("finds a live run in a project whose directory mtime is old (the core bug)", () => {
    base = mkdtempSync(join(tmpdir(), "lifeline-disc-"));
    const now = Date.now();
    const live = mkRun(base, "p-longlived", "s-old", "wf_now");
    // Age the whole directory chain as if the session was created long ago, but the journal
    // file itself was just appended to. The old dir-mtime scan skipped this; this must not.
    const when = (now - 3 * 60 * 60_000) / 1000;
    let cur = live;
    for (let i = 0; i < 6; i++) {
      try { utimesSync(cur, when, when); } catch { /* */ }
      cur = join(cur, "..");
    }
    // journal.jsonl stays fresh (just written) — project pre-filter off so the old dir mtime
    // doesn't hide it either.
    const found = discoverActiveRunDirs(base, 15 * 60_000, now, 0);
    expect(found).toContain(live);
  });

  it("the wide project pre-filter skips ancient scratch projects cheaply", () => {
    base = mkdtempSync(join(tmpdir(), "lifeline-disc-"));
    const now = Date.now();
    // An ancient scratch project (dir mtime 30 days old) with a run — pre-filtered out.
    const ancient = mkRun(base, "p-scratch", "s", "wf_old");
    const old = (now - 30 * 24 * 60 * 60_000) / 1000;
    utimesSync(join(base, "p-scratch"), old, old);
    const live = mkRun(base, "p-live", "s", "wf_now");
    const found = discoverActiveRunDirs(base, 15 * 60_000, now); // default 7-day pre-filter
    expect(found).toContain(live);
    expect(found).not.toContain(ancient);
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

/**
 * Regression cover for the masked API error. `apiErrorFromTail` walks the tail backwards for
 * the newest API error and stops at the first ordinary line, on the sound principle that an
 * agent which errored and then kept working is not lost. But a trailing line carrying no work
 * counted as "kept working": on the real run below, an agent died on "API Error: Connection
 * closed mid-response", an interrupt was recorded after it, and that single line hid the error.
 * The agent was filed as merely stalled and took the slow path instead of CONN.
 */
describe("apiErrorFromTail sees past lines that carry no work", () => {
  const err = JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    message: { content: "API Error: Connection closed mid-response." },
  });
  const interrupted = JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });
  const realWork = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Right, carrying on with the migration." }] },
  });

  it("finds the error beneath a trailing interrupt (the observed failure)", () => {
    expect(apiErrorFromTail(`${err}\n${interrupted}\n`)).not.toBeNull();
  });

  it("finds it beneath several such lines", () => {
    expect(apiErrorFromTail(`${err}\n${interrupted}\n${interrupted}\n`)).not.toBeNull();
  });

  it("still reports nothing when the agent genuinely recovered", () => {
    expect(apiErrorFromTail(`${err}\n${realWork}\n`)).toBeNull();
  });

  it("does not invent an error from an interrupt alone", () => {
    expect(apiErrorFromTail(`${realWork}\n${interrupted}\n`)).toBeNull();
  });

  it("finds a plain trailing error, as it always did", () => {
    expect(apiErrorFromTail(`${realWork}\n${err}\n`)).not.toBeNull();
  });
})
