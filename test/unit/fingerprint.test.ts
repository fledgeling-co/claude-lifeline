/**
 * Fingerprint evals — the fail-closed version gate.
 *
 * A new Claude Code version lands roughly daily. lifeline must bless a version only after
 * re-verifying the three contracts it actually reads against, and must raise the
 * incompatibility flag rather than mis-apply recovery when one of them moves. Every filesystem
 * dependency is injected, so nothing here reads the real binary or the real journals.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../../src/shared/paths.js";
import type { ProbeInputs, ProbeName } from "../../src/fingerprint/contracts.js";
import { PROBE_NAMES, WORKFLOW_MARKERS, generalizeJournalPath } from "../../src/fingerprint/contracts.js";
import type { Fingerprint, FingerprintDeps } from "../../src/fingerprint/index.js";
import {
  checkInstalledVersion,
  clearIncompatFlag,
  compareFingerprint,
  compareVersions,
  computeFingerprint,
  detectInstalledVersion,
  driftMessage,
  isFingerprint,
  isVersionName,
  listFingerprints,
  loadFingerprint,
  readBinaryMarkers,
  readIncompatFlag,
  waitForBinarySettle,
  saveFingerprint,
  sha256,
} from "../../src/fingerprint/index.js";
import { useTempEnv } from "../support/tmp.js";

const VERSION = "2.1.224";
const NOW = 1_700_000_000_000;

/** A journal sample whose `started`/`result` lines carry the keys the daemon parses. */
const JOURNAL_ENTRIES: Record<string, unknown>[] = [
  { type: "started", key: "sha-1", agentId: "a1", at: 1 },
  { type: "result", key: "sha-1", agentId: "a1", at: 2, result: "ok" },
  { type: "started", key: "sha-2", agentId: "a2", at: 3 },
];

const JOURNAL_PATHS = [
  "/Users/luke/.claude/projects/-Users-luke-Dev-lifeline/9f1c/subagents/workflows/wf_abc/journal.jsonl",
  "/Users/luke/.claude/projects/-Users-luke-Dev-anvil/2b7d/subagents/workflows/wf_def/journal.jsonl",
];

function markers(over: Record<string, boolean> = {}): Record<string, boolean> {
  const base: Record<string, boolean> = {};
  for (const marker of WORKFLOW_MARKERS) base[marker] = true;
  return { ...base, ...over };
}

function inputs(over: Partial<ProbeInputs> = {}): ProbeInputs {
  return {
    "journal-line-shape": { entries: JOURNAL_ENTRIES },
    "disk-layout": { journalPaths: JOURNAL_PATHS },
    "workflow-tool-anchors": { markers: markers() },
    ...over,
  };
}

/** Fully-injected deps: no real versions dir walk, no 265MB binary read, no journal walk. */
function deps(over: Partial<FingerprintDeps> = {}, marks = markers()): FingerprintDeps {
  return {
    projectsDir: () => "/synthetic/projects",
    binaryPath: (v) => `/synthetic/versions/${v}`,
    readBinaryMarkers: () => Promise.resolve(marks),
    listJournalPaths: () => JOURNAL_PATHS,
    readJournalEntries: () => JOURNAL_ENTRIES,
    now: () => NOW,
    ...over,
  };
}

describe("sha256 / computeFingerprint purity", () => {
  it("hashes deterministically", () => {
    expect(sha256("lifeline")).toBe(sha256("lifeline"));
    expect(sha256("lifeline")).not.toBe(sha256("lifelinf"));
    expect(sha256("")).toHaveLength(64);
  });

  it("is stable across repeated runs over identical inputs", () => {
    const a = computeFingerprint(VERSION, inputs(), () => NOW);
    const b = computeFingerprint(VERSION, inputs(), () => NOW + 999_999);
    expect(a.probes).toEqual(b.probes);
    expect(a.version).toBe(VERSION);
    // createdAt is diagnostic only and must never enter the comparison.
    expect(compareFingerprint(a, b).compatible).toBe(true);
  });

  it("covers every declared probe", () => {
    const fp = computeFingerprint(VERSION, inputs(), () => NOW);
    expect(Object.keys(fp.probes).sort()).toEqual([...PROBE_NAMES].sort());
    for (const name of PROBE_NAMES) {
      expect(fp.probes[name].sha256).toBe(sha256(fp.probes[name].value));
    }
  });

  it("is insensitive to an ADDITIVE journal key (a new optional field breaks no reader)", () => {
    const base = computeFingerprint(VERSION, inputs(), () => NOW);
    const withExtra = computeFingerprint(
      VERSION,
      inputs({
        "journal-line-shape": {
          entries: [
            ...JOURNAL_ENTRIES,
            { type: "started", key: "sha-3", agentId: "a3", at: 4, brandNewField: true },
          ],
        },
      }),
      () => NOW,
    );
    expect(compareFingerprint(base, withExtra).compatible).toBe(true);
  });

  it("is sensitive to a REMOVED journal key (a vanished field does break a reader)", () => {
    const base = computeFingerprint(VERSION, inputs(), () => NOW);
    const withoutKey = computeFingerprint(
      VERSION,
      inputs({
        "journal-line-shape": {
          entries: [
            { type: "started", agentId: "a1", at: 1 },
            { type: "result", agentId: "a1", at: 2, result: "ok" },
          ],
        },
      }),
      () => NOW,
    );
    expect(compareFingerprint(base, withoutKey).drifted).toContain("journal-line-shape");
  });
});

describe("compareFingerprint", () => {
  const baseline = computeFingerprint(VERSION, inputs(), () => NOW);

  it("reports compatible when every probe hash matches", () => {
    expect(compareFingerprint(baseline, computeFingerprint(VERSION, inputs(), () => NOW))).toEqual({
      compatible: true,
      drifted: [],
    });
  });

  it("flags drift when a binary anchor disappears", () => {
    const current = computeFingerprint(
      VERSION,
      inputs({ "workflow-tool-anchors": { markers: markers({ resumeFromRunId: false }) } }),
      () => NOW,
    );
    const diff = compareFingerprint(baseline, current);
    expect(diff.compatible).toBe(false);
    expect(diff.drifted).toEqual(["workflow-tool-anchors"]);
  });

  it("flags drift when the disk layout moves", () => {
    const current = computeFingerprint(
      VERSION,
      inputs({
        "disk-layout": { journalPaths: ["/Users/luke/.claude/projects/p/s/agents/runs/wf_abc/journal.jsonl"] },
      }),
      () => NOW,
    );
    expect(compareFingerprint(baseline, current).drifted).toEqual(["disk-layout"]);
  });

  it("flags every probe when several move at once", () => {
    const current = computeFingerprint(
      VERSION,
      {
        "journal-line-shape": { entries: [] },
        "disk-layout": { journalPaths: [] },
        "workflow-tool-anchors": { markers: {} },
      },
      () => NOW,
    );
    expect(compareFingerprint(baseline, current).drifted.sort()).toEqual([...PROBE_NAMES].sort());
  });

  it("treats a probe missing from the baseline as drift — unverified is not compatible", () => {
    const partial: Fingerprint = {
      version: VERSION,
      createdAt: NOW,
      probes: { "disk-layout": baseline.probes["disk-layout"] } as Fingerprint["probes"],
    };
    const diff = compareFingerprint(partial, baseline);
    expect(diff.compatible).toBe(false);
    expect(diff.drifted).toContain("journal-line-shape");
    expect(diff.drifted).toContain("workflow-tool-anchors");
    expect(diff.drifted).not.toContain("disk-layout");
  });
});

describe("path generalisation", () => {
  it("keeps only the contract tail and generalises the volatile segments", () => {
    expect(generalizeJournalPath(JOURNAL_PATHS[0] as string)).toBe(
      "subagents/workflows/wf_*/journal.jsonl",
    );
  });

  it("marks a path that does not contain the anchor as unrecognized", () => {
    expect(generalizeJournalPath("/somewhere/else/journal.jsonl")).toContain("<unrecognized>");
  });
});

describe("version detection and ordering", () => {
  const tmp = useTempEnv();

  it("accepts real version names and rejects the wrapper name", () => {
    expect(isVersionName("2.1.224")).toBe(true);
    expect(isVersionName("2.1")).toBe(true);
    expect(isVersionName("2.1.224-beta.1")).toBe(true);
    expect(isVersionName("claude")).toBe(false);
    expect(isVersionName("lifeline-wrapper")).toBe(false);
  });

  it("orders by numeric segment", () => {
    expect(compareVersions("2.1.224", "2.1.223")).toBeGreaterThan(0);
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareVersions("2.1.224", "2.1.224")).toBe(0);
  });

  it("picks the newest installed version", () => {
    const dir = tmp.env.versions;
    for (const v of ["2.1.221", "2.1.224", "2.1.223", "not-a-version"]) {
      writeFileSync(join(dir, v), "binary", "utf8");
    }
    expect(detectInstalledVersion({ versionsDir: () => dir })).toBe("2.1.224");
  });

  it("returns null when nothing version-shaped is installed", () => {
    expect(
      detectInstalledVersion({
        versionsDir: () => tmp.env.versions,
        symlinkPath: join(tmp.env.root, "no-such-symlink"),
      }),
    ).toBeNull();
  });
});

describe("readBinaryMarkers", () => {
  const tmp = useTempEnv();

  it("finds markers that straddle a chunk boundary", async () => {
    const file = join(tmp.env.root, "fake-binary");
    // 'resumeFromRunId' is deliberately placed so a small chunk size splits it in two.
    writeFileSync(file, `${"x".repeat(20)}resumeFromRunId${"y".repeat(20)}journal.jsonl`, "utf8");
    const found = await readBinaryMarkers(file, ["resumeFromRunId", "journal.jsonl", "absent-atom"], 8);
    expect(found["resumeFromRunId"]).toBe(true);
    expect(found["journal.jsonl"]).toBe(true);
    expect(found["absent-atom"]).toBe(false);
  });

  it("fails closed on an unreadable file — every marker absent", async () => {
    const found = await readBinaryMarkers(join(tmp.env.root, "missing"), [...WORKFLOW_MARKERS]);
    for (const marker of WORKFLOW_MARKERS) expect(found[marker]).toBe(false);
  });
});

describe("checkInstalledVersion — the fail-closed gate", () => {
  const tmp = useTempEnv();

  function installVersion(version = VERSION): string {
    writeFileSync(join(tmp.env.versions, version), "binary", "utf8");
    return version;
  }

  function versionDeps(over: Partial<FingerprintDeps> = {}, marks = markers()): FingerprintDeps {
    return deps({ versionsDir: () => tmp.env.versions, ...over }, marks);
  }

  it("records a baseline on first sight and clears any flag", async () => {
    installVersion();
    const result = await checkInstalledVersion(versionDeps());

    expect(result.version).toBe(VERSION);
    expect(result.compatible).toBe(true);
    expect(result.reason).toBe("baseline-recorded");
    expect(result.flag).toBeNull();
    expect(loadFingerprint(VERSION)).not.toBeNull();
    expect(existsSync(paths.incompatFlag())).toBe(false);
  });

  it("verifies a known version against its own baseline", async () => {
    installVersion();
    await checkInstalledVersion(versionDeps());
    const second = await checkInstalledVersion(versionDeps());

    expect(second.reason).toBe("verified");
    expect(second.compatible).toBe(true);
    expect(second.drifted).toEqual([]);
    expect(readIncompatFlag()).toBeNull();
  });

  it("blesses a NEW version whose contract still matches the last verified baseline", async () => {
    installVersion("2.1.224");
    await checkInstalledVersion(versionDeps());

    writeFileSync(join(tmp.env.versions, "2.1.225"), "binary", "utf8");
    const result = await checkInstalledVersion(versionDeps());

    expect(result.version).toBe("2.1.225");
    expect(result.reason).toBe("verified-and-blessed");
    expect(result.compatible).toBe(true);
    expect(listFingerprints()).toContain("2.1.225");
    expect(readIncompatFlag()).toBeNull();
  });

  it("writes the incompatibility flag on contract drift, and leaves the verified baseline alone", async () => {
    installVersion();
    const baselineRun = await checkInstalledVersion(versionDeps());
    const baseline = loadFingerprint(VERSION);
    expect(baseline).not.toBeNull();
    expect(baselineRun.compatible).toBe(true);

    writeFileSync(join(tmp.env.versions, "2.1.225"), "binary", "utf8");
    const drifted = await checkInstalledVersion(versionDeps({}, markers({ workflow_agent: false })));

    expect(drifted.compatible).toBe(false);
    expect(drifted.reason).toBe("contract-drift");
    expect(drifted.drifted).toEqual(["workflow-tool-anchors"]);

    const flag = readIncompatFlag();
    expect(flag).not.toBeNull();
    expect(flag?.version).toBe("2.1.225");
    expect(flag?.drifted).toEqual(["workflow-tool-anchors"]);
    expect(flag?.message).toContain("reduced mode");
    expect(flag?.at).toBe(NOW);

    // The drifted version must NOT be recorded as verified.
    expect(loadFingerprint("2.1.225")).toBeNull();
    expect(loadFingerprint(VERSION)).toEqual(baseline);
  });

  it("clears the flag once the contract matches again", async () => {
    installVersion();
    await checkInstalledVersion(versionDeps());

    writeFileSync(join(tmp.env.versions, "2.1.225"), "binary", "utf8");
    await checkInstalledVersion(versionDeps({}, markers({ workflow_agent: false })));
    expect(readIncompatFlag()).not.toBeNull();

    const recovered = await checkInstalledVersion(versionDeps());
    expect(recovered.compatible).toBe(true);
    expect(readIncompatFlag()).toBeNull();
    expect(existsSync(paths.incompatFlag())).toBe(false);
  });

  it("flags rather than assumes when the version cannot be determined at all", async () => {
    const result = await checkInstalledVersion(
      versionDeps({ symlinkPath: join(tmp.env.root, "no-such-symlink") }),
    );

    expect(result.version).toBeNull();
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe("version-undetectable");
    expect(readIncompatFlag()?.version).toBe("unknown");
  });

  it("clearIncompatFlag is a no-op when there is nothing to clear", () => {
    expect(() => clearIncompatFlag()).not.toThrow();
    expect(readIncompatFlag()).toBeNull();
  });

  it("persists a fingerprint under a filename-safe version string", () => {
    saveFingerprint({ version: "2.1.224/../evil", probes: {} as Fingerprint["probes"], createdAt: NOW });
    for (const name of listFingerprints()) expect(name).not.toContain("/");
  });
});

describe("driftMessage / isFingerprint", () => {
  it("names each drifted probe and what it describes", () => {
    const message = driftMessage("2.1.225", ["workflow-tool-anchors", "disk-layout"] as ProbeName[]);
    expect(message).toContain("2.1.225");
    expect(message).toContain("reduced mode");
    expect(message).toContain("workflow-tool-anchors");
    expect(message).toContain("disk-layout");
  });

  it("rejects anything that is not a fingerprint", () => {
    expect(isFingerprint(null)).toBe(false);
    expect(isFingerprint({})).toBe(false);
    expect(isFingerprint({ version: "1", probes: null })).toBe(false);
    expect(isFingerprint({ version: "1", probes: {} })).toBe(true);
  });
});

describe("fingerprint directory hygiene", () => {
  const tmp = useTempEnv();

  it("keeps every artefact inside LIFELINE_HOME", () => {
    mkdirSync(paths.fingerprintsDir(), { recursive: true });
    saveFingerprint(computeFingerprint(VERSION, inputs(), () => NOW));
    expect(paths.fingerprintsDir().startsWith(tmp.env.home)).toBe(true);
    expect(existsSync(join(paths.fingerprintsDir(), `${VERSION}.json`))).toBe(true);
  });
});

/**
 * The settle gate. Regression cover for the false-drift race observed in the field on
 * 2.1.225 and 2.1.226: launchd wakes the watcher on the filesystem event that STARTS the
 * ~265MB download, so probing immediately read a partial binary, found none of the workflow
 * markers, and flagged a version that was in fact fine — self-healing only because a later
 * event happened to fire.
 */
describe("waitForBinarySettle", () => {
  const PATH = "/synthetic/versions/2.1.226";

  /** A clock the test drives, so nothing ever really sleeps. */
  function fakeClock(startAt = 1_000_000) {
    let t = startAt;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
      at: () => t,
    };
  }

  it("returns immediately for a file that settled long ago — no sleeping on the common path", async () => {
    const clock = fakeClock();
    let sleeps = 0;
    const outcome = await waitForBinarySettle(PATH, {
      now: clock.now,
      sleep: (ms) => {
        sleeps += 1;
        return clock.sleep(ms);
      },
      statFile: () => ({ mtimeMs: clock.at() - 60_000 }),
    });
    expect(outcome).toBe("settled");
    expect(sleeps).toBe(0);
  });

  it("reports absent when there is nothing to stat", async () => {
    const outcome = await waitForBinarySettle(PATH, { statFile: () => null });
    expect(outcome).toBe("absent");
  });

  it("waits while the file is still being written, then settles once it goes quiet", async () => {
    const clock = fakeClock();
    // Mimics a download: mtime keeps pace with now until the writer stops.
    const writingUntil = clock.at() + 4_000;
    const outcome = await waitForBinarySettle(PATH, {
      stabilityMs: 5_000,
      pollMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      statFile: () => ({ mtimeMs: Math.min(clock.at(), writingUntil) }),
    });
    expect(outcome).toBe("settled");
    // It cannot have settled before the writer stopped plus the stability window.
    expect(clock.at()).toBeGreaterThanOrEqual(writingUntil + 5_000);
  });

  it("gives up with timeout on a file that never stops changing", async () => {
    const clock = fakeClock();
    const outcome = await waitForBinarySettle(PATH, {
      stabilityMs: 5_000,
      timeoutMs: 30_000,
      pollMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      statFile: () => ({ mtimeMs: clock.at() }),
    });
    expect(outcome).toBe("timeout");
  });

  it("treats a future mtime as settled rather than blocking for the whole timeout", async () => {
    const clock = fakeClock();
    const outcome = await waitForBinarySettle(PATH, {
      now: clock.now,
      sleep: clock.sleep,
      statFile: () => ({ mtimeMs: clock.at() + 10_000 }),
    });
    expect(outcome).toBe("settled");
  });
});

describe("checkInstalledVersion settles the binary before probing", () => {
  const tmp = useTempEnv();

  it("waits for the binary, and probes only after it has settled", async () => {
    writeFileSync(join(tmp.env.versions, VERSION), "binary", "utf8");
    const order: string[] = [];

    const result = await checkInstalledVersion(
      deps(
        {
          versionsDir: () => tmp.env.versions,
          waitForBinarySettle: () => {
            order.push("settle");
            return Promise.resolve("settled" as const);
          },
          readBinaryMarkers: () => {
            order.push("probe");
            return Promise.resolve(markers());
          },
        },
      ),
    );

    expect(order).toEqual(["settle", "probe"]);
    expect(result.settle).toBe("settled");
  });

  it("still probes and fails closed when the binary never settles", async () => {
    writeFileSync(join(tmp.env.versions, VERSION), "binary", "utf8");
    // A baseline exists, so an incomplete read must show up as drift rather than be blessed.
    await checkInstalledVersion(deps({ versionsDir: () => tmp.env.versions }));

    const result = await checkInstalledVersion(
      deps(
        {
          versionsDir: () => tmp.env.versions,
          waitForBinarySettle: () => Promise.resolve("timeout" as const),
        },
        markers({ workflow_agent: false }),
      ),
    );

    expect(result.settle).toBe("timeout");
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe("contract-drift");
  });

  it("refuses to record a BASELINE from a binary that never settled", async () => {
    // The inverse of the drift case above, and the more damaging one: with no baseline yet,
    // blessing a half-written binary pins permanent false drift on a version that is fine.
    writeFileSync(join(tmp.env.versions, VERSION), "binary", "utf8");

    const result = await checkInstalledVersion(
      deps(
        {
          versionsDir: () => tmp.env.versions,
          waitForBinarySettle: () => Promise.resolve("timeout" as const),
        },
        markers({ workflow_agent: false }),
      ),
    );

    expect(result.settle).toBe("timeout");
    expect(result.reason).toBe("unsettled-no-baseline");
    expect(existsSync(join(paths.fingerprintsDir(), `${VERSION}.json`))).toBe(false);

    // And once it does settle, the real markers become the baseline.
    const after = await checkInstalledVersion(deps({ versionsDir: () => tmp.env.versions }));
    expect(after.reason).toBe("baseline-recorded");
    expect(existsSync(join(paths.fingerprintsDir(), `${VERSION}.json`))).toBe(true);
  });
});
