/** The wrapper's upstream transition must never retain Relay identity for a prior route. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "install", "update-gateway-upstream.mjs");
let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function configFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "lifeline-upstream-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

function update(path: string, upstream: string): string {
  return execFileSync(process.execPath, [SCRIPT, path, upstream], { encoding: "utf8" }).trim();
}

describe("gateway upstream transition", () => {
  it("atomically clears a Relay marker when replacing its upstream", () => {
    const path = configFile({
      gatewayPort: 8787,
      upstream: "http://127.0.0.1:8858",
      relayBridge: { lastKnownPort: 8858 },
      requestBudgetMs: 90_000,
    });

    expect(update(path, "http://127.0.0.1:8857")).toBe("changed");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      gatewayPort: 8787,
      upstream: "http://127.0.0.1:8857",
      requestBudgetMs: 90_000,
    });
  });

  it("is a byte-preserving no-op when the upstream has not changed", () => {
    const path = configFile({ upstream: "http://127.0.0.1:8858", relayBridge: { lastKnownPort: 8858 } });
    const before = readFileSync(path, "utf8");
    expect(update(path, "http://127.0.0.1:8858")).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
