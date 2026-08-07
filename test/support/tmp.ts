/**
 * Hermetic temp-directory support for the eval harness.
 *
 * Every lifeline path is derived from `LIFELINE_HOME` / `LIFELINE_PROJECTS_DIR` /
 * `LIFELINE_CLAUDE_VERSIONS_DIR` at CALL time (see src/shared/paths.ts), so redirecting a
 * test is just a matter of setting those three variables before the code under test runs.
 * Nothing here touches the real `~/.lifeline` or `~/.claude`.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Env vars this helper owns. Saved and restored around every temp env. */
const OWNED_ENV = [
  "LIFELINE_HOME",
  "LIFELINE_PROJECTS_DIR",
  "LIFELINE_CLAUDE_VERSIONS_DIR",
  "LIFELINE_UPSTREAM",
  "LIFELINE_GATEWAY_PORT",
] as const;

export interface TempEnv {
  /** Root of the throwaway tree; everything below lives inside it. */
  root: string;
  /** LIFELINE_HOME — ledger, status.json, intents, connectivity, fingerprints. */
  home: string;
  /** LIFELINE_PROJECTS_DIR — the synthesised stand-in for ~/.claude/projects. */
  projects: string;
  /** LIFELINE_CLAUDE_VERSIONS_DIR — the stand-in for the installed-versions dir. */
  versions: string;
  /** Restore the previous env and delete the tree. Safe to call twice. */
  cleanup(): void;
}

/**
 * Create an isolated lifeline environment and point the env vars at it.
 * Prefer `useTempEnv()` in a suite; this is the manual escape hatch.
 */
export function createTempEnv(prefix = "lifeline-test-"): TempEnv {
  const saved = new Map<string, string | undefined>();
  for (const key of OWNED_ENV) saved.set(key, process.env[key]);

  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "lifeline");
  const projects = join(root, "projects");
  const versions = join(root, "versions");
  for (const dir of [home, projects, versions]) mkdirSync(dir, { recursive: true });

  process.env.LIFELINE_HOME = home;
  process.env.LIFELINE_PROJECTS_DIR = projects;
  process.env.LIFELINE_CLAUDE_VERSIONS_DIR = versions;

  let cleaned = false;
  return {
    root,
    home,
    projects,
    versions,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface TempEnvRef {
  /** The env for the current test. Throws outside a test body. */
  readonly env: TempEnv;
}

/**
 * Register a fresh temp env per test. Returns a live reference rather than the env itself,
 * because the env is rebuilt in `beforeEach` and a captured value would go stale.
 */
export function useTempEnv(prefix?: string): TempEnvRef {
  let current: TempEnv | null = null;

  beforeEach(() => {
    current = createTempEnv(prefix);
  });

  afterEach(() => {
    current?.cleanup();
    current = null;
  });

  return {
    get env(): TempEnv {
      if (current === null) throw new Error("useTempEnv(): no temp env — call inside a test body");
      return current;
    },
  };
}

/** Poll `predicate` until it is true or `timeoutMs` elapses. Returns whether it became true. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
}
