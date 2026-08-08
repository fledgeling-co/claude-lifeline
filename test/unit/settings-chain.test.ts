/**
 * The settings chain, exercised through the real `install/patch-settings.mjs`.
 *
 * This script is the only thing that edits a file lifeline does not own, so the properties that
 * matter are conservative ones: preserve every key it did not come for, record the pre-lifeline
 * value once so uninstall can restore it exactly, and publish what it displaced so a sibling tool
 * that also owns ANTHROPIC_BASE_URL can tell "chained in front of me" from "overwritten".
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "install", "patch-settings.mjs");
const GATEWAY = "http://127.0.0.1:8787";
const PROXY = "http://127.0.0.1:8858";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function sandbox(settings: unknown): { home: string; settingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "lifeline-chain-"));
  dirs.push(dir);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { home: join(dir, "home"), settingsPath };
}

function run(mode: string, box: { home: string; settingsPath: string }, arg?: string): string {
  const args = arg === undefined ? [SCRIPT, mode] : [SCRIPT, mode, arg];
  return execFileSync(process.execPath, args, {
    env: { ...process.env, LIFELINE_HOME: box.home, LIFELINE_CLAUDE_SETTINGS: box.settingsPath },
    encoding: "utf8",
  }).trim();
}

const envOf = (box: { settingsPath: string }): Record<string, string> =>
  JSON.parse(readFileSync(box.settingsPath, "utf8")).env ?? {};

describe("patch-settings apply", () => {
  it("chains the gateway in and reports what it displaced", () => {
    const box = sandbox({ env: { ANTHROPIC_BASE_URL: PROXY } });
    expect(run("apply", box, GATEWAY)).toBe(PROXY);
    expect(envOf(box).ANTHROPIC_BASE_URL).toBe(GATEWAY);
  });

  it("publishes the displaced upstream so a sibling proxy can stand down", () => {
    const box = sandbox({ env: { ANTHROPIC_BASE_URL: PROXY } });
    run("apply", box, GATEWAY);
    expect(envOf(box).LIFELINE_CHAINED_UPSTREAM).toBe(PROXY);
  });

  it("publishes no marker when it displaced nothing", () => {
    const box = sandbox({ env: { OTHER: "keep" } });
    run("apply", box, GATEWAY);
    expect(envOf(box).LIFELINE_CHAINED_UPSTREAM).toBeUndefined();
  });

  it("leaves every unrelated key alone", () => {
    const box = sandbox({ permissions: { deny: [] }, env: { ANTHROPIC_BASE_URL: PROXY, KEEP: "1" } });
    run("apply", box, GATEWAY);
    expect(envOf(box).KEEP).toBe("1");
    expect(JSON.parse(readFileSync(box.settingsPath, "utf8")).permissions).toEqual({ deny: [] });
  });

  it("is idempotent — a second apply changes nothing and re-reports the original", () => {
    const box = sandbox({ env: { ANTHROPIC_BASE_URL: PROXY } });
    run("apply", box, GATEWAY);
    const after = readFileSync(box.settingsPath, "utf8");
    expect(run("apply", box, GATEWAY)).toBe(PROXY);
    expect(readFileSync(box.settingsPath, "utf8")).toBe(after);
  });

  it("treats a trailing-slash gateway as already chained", () => {
    const box = sandbox({ env: { ANTHROPIC_BASE_URL: `${GATEWAY}/` } });
    run("apply", box, GATEWAY);
    // Never sets itself as its own upstream, which would loop every request back into the gateway.
    expect(envOf(box).LIFELINE_CHAINED_UPSTREAM).toBeUndefined();
  });

  it("records the pre-lifeline value once, not the drifted one", () => {
    const box = sandbox({ env: { ANTHROPIC_BASE_URL: PROXY } });
    run("apply", box, GATEWAY);
    writeFileSync(box.settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://other:1" } }));
    run("apply", box, GATEWAY);
    const record = JSON.parse(readFileSync(join(box.home, "settings-base-url.orig.json"), "utf8"));
    expect(record.original).toBe(PROXY);
  });
});

describe("patch-settings revert", () => {
  it("restores the original and takes the marker with it", () => {
    const box = sandbox({ env: { ANTHROPIC_BASE_URL: PROXY, KEEP: "1" } });
    run("apply", box, GATEWAY);
    run("revert", box);
    const env = envOf(box);
    expect(env.ANTHROPIC_BASE_URL).toBe(PROXY);
    expect(env.LIFELINE_CHAINED_UPSTREAM).toBeUndefined();
    expect(env.KEEP).toBe("1");
  });

  it("removes the key entirely when there was none before", () => {
    const box = sandbox({ env: { OTHER: "keep" } });
    run("apply", box, GATEWAY);
    run("revert", box);
    expect(envOf(box).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(envOf(box).OTHER).toBe("keep");
  });

  it("does nothing when there is no record to restore from", () => {
    const box = sandbox({ env: { ANTHROPIC_BASE_URL: PROXY } });
    run("revert", box);
    expect(existsSync(join(box.home, "settings-base-url.orig.json"))).toBe(false);
    expect(envOf(box).ANTHROPIC_BASE_URL).toBe(PROXY);
  });
});
