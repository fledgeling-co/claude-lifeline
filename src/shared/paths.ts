import { homedir } from "node:os";
import { join } from "node:path";

/** All runtime state lives under ~/.lifeline (gitignored; created at install/first-run). */
export function lifelineHome(): string {
  return process.env.LIFELINE_HOME ?? join(homedir(), ".lifeline");
}

export const paths = {
  home: lifelineHome,
  config: () => join(lifelineHome(), "config.json"),
  ledgerDir: () => join(lifelineHome(), "ledger"),
  ledgerFile: (runId: string) => join(lifelineHome(), "ledger", `${runId}.json`),
  status: () => join(lifelineHome(), "status.json"),
  intentsDir: () => join(lifelineHome(), "intents"),
  connectivity: () => join(lifelineHome(), "connectivity.json"),
  fingerprintsDir: () => join(lifelineHome(), "fingerprints"),
  incompatFlag: () => join(lifelineHome(), "incompatible.json"),
  logDir: () => join(lifelineHome(), "logs"),
};

/** Where Claude Code keeps workflow journals. Overridable for tests. */
export function claudeProjectsDir(): string {
  return process.env.LIFELINE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** Where the native Claude Code versions live. */
export function claudeVersionsDir(): string {
  return (
    process.env.LIFELINE_CLAUDE_VERSIONS_DIR ??
    join(homedir(), ".local", "share", "claude", "versions")
  );
}
