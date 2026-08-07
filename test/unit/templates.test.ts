import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferSchema, validateAgainst } from "../../src/templates/infer.js";
import {
  parseScriptMeta,
  saveTemplate,
  listTemplates,
  materializeRun,
  mineTemplates,
} from "../../src/templates/store.js";
import { generateDrainScript } from "../../src/templates/drain.js";

describe("inferSchema", () => {
  it("infers primitive types with the literal as default", () => {
    expect(inferSchema("x")).toEqual({ type: "string", default: "x" });
    expect(inferSchema(3)).toEqual({ type: "integer", default: 3 });
    expect(inferSchema(3.5)).toEqual({ type: "number", default: 3.5 });
    expect(inferSchema(true)).toEqual({ type: "boolean", default: true });
  });

  it("infers objects with required keys and arrays with item schemas", () => {
    const s = inferSchema({ files: ["a.ts", "b.ts"], depth: 2 });
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["files", "depth"]);
    expect(s.properties?.files?.items?.type).toBe("string");
  });

  it("records mixed-element arrays as anyOf rather than averaging", () => {
    const s = inferSchema([1, "two"]);
    expect(s.anyOf).toHaveLength(2);
  });

  it("validateAgainst accepts the defaults, rejects type mismatches, allows extra keys", () => {
    const s = inferSchema({ name: "x", n: 1 });
    expect(validateAgainst(s, { name: "y", n: 2 })).toEqual([]);
    expect(validateAgainst(s, { name: "y", n: 2, extra: true })).toEqual([]);
    expect(validateAgainst(s, { name: 5, n: 2 })).not.toEqual([]);
    expect(validateAgainst(s, { name: "y" })).not.toEqual([]); // missing required
    expect(validateAgainst(inferSchema(1), 1.5)).not.toEqual([]); // integer vs float
  });
});

describe("template store", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.LIFELINE_HOME;
    delete process.env.LIFELINE_PROJECTS_DIR;
    dir = null;
  });

  const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions',
  phases: [{ title: 'Review' }],
}
const out = await agent('review ' + JSON.stringify(args))
return out
`;

  function setup(): { home: string; scriptPath: string } {
    dir = mkdtempSync(join(tmpdir(), "lifeline-tpl-"));
    process.env.LIFELINE_HOME = join(dir, "home");
    const scriptPath = join(dir, "review-wf_abc.js");
    writeFileSync(scriptPath, SCRIPT);
    return { home: process.env.LIFELINE_HOME, scriptPath };
  }

  it("parseScriptMeta pulls name and description textually", () => {
    expect(parseScriptMeta(SCRIPT)).toEqual({
      name: "review-changes",
      description: "Review changed files across dimensions",
    });
  });

  it("save -> list -> materialize round-trips with schema validation", () => {
    const { scriptPath } = setup();
    const meta = saveTemplate({ scriptPath, args: { files: ["a.ts"], depth: 2 }, runId: "wf_abc" });
    expect(meta.name).toBe("review-changes");
    expect(listTemplates().map((t) => t.name)).toContain("review-changes");

    const run = materializeRun("review-changes");
    expect(run?.validationErrors).toEqual([]);
    expect(run?.args).toEqual({ files: ["a.ts"], depth: 2 });
    expect(run?.invocation).toContain("Workflow({ scriptPath:");

    const bad = materializeRun("review-changes", { files: "not-an-array", depth: 2 });
    expect(bad?.validationErrors.length).toBeGreaterThan(0);

    const good = materializeRun("review-changes", { files: ["x.ts", "y.ts"], depth: 3 });
    expect(good?.validationErrors).toEqual([]);
    expect(good?.invocation).toContain('"x.ts"');
  });

  it("materializeRun returns null for an unknown template", () => {
    setup();
    expect(materializeRun("nope")).toBeNull();
  });

  it("mineTemplates clusters persisted scripts by meta.name", () => {
    const { } = setup();
    const projects = join(dir!, "projects");
    for (const [proj, session, n] of [
      ["p1", "s1", 1],
      ["p1", "s2", 2],
      ["p2", "s3", 3],
    ] as const) {
      const scriptsDir = join(projects, proj, session, "workflows", "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(scriptsDir, `review-wf_${n}.js`), SCRIPT);
    }
    const singleDir = join(projects, "p2", "s3", "workflows", "scripts");
    writeFileSync(join(singleDir, "oneoff-wf_9.js"), SCRIPT.replace("review-changes", "one-off"));

    const mined = mineTemplates(projects);
    const review = mined.find((c) => c.name === "review-changes");
    expect(review?.occurrences).toBe(3);
    expect(mined[0]?.name).toBe("review-changes"); // sorted by occurrences
  });
});

describe("drain script generation", () => {
  it("bakes the mailbox path in, loops until dry, and is sandbox-legal", () => {
    process.env.LIFELINE_HOME = "/tmp/lifeline-test-home";
    const src = generateDrainScript({ mailboxId: "proj x", emptyRounds: 3, maxItems: 7 });
    delete process.env.LIFELINE_HOME;
    expect(src).toContain("lifeline-drain-proj-x");
    expect(src).toContain("proj-x.json");
    expect(src).toContain("empty < 3");
    expect(src).toContain("processed < 7");
    // Sandbox constraints: no fs/Date.now/Math.random in the SCRIPT itself (agents do I/O).
    expect(src).not.toMatch(/require\(|import |Date\.now|Math\.random/);
    // It must carry the meta literal the Workflow tool requires.
    expect(src).toMatch(/^export const meta = \{/);
  });
});
