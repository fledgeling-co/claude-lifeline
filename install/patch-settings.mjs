#!/usr/bin/env node
/**
 * Chain lifeline's gateway into ~/.claude/settings.json.
 *
 * Claude Code applies settings.json `env` itself, so a base URL there outranks anything
 * the wrapper exports. To chain claude -> gateway -> (existing proxy) -> API we must move
 * the settings value: the old value becomes the gateway's upstream, the settings value
 * becomes the gateway. The original is recorded under ~/.lifeline so revert is exact.
 *
 *   node patch-settings.mjs apply  <gatewayUrl>   prints the displaced value (or "")
 *   node patch-settings.mjs revert                restores the recorded original
 *
 * `apply` is safe to re-run: it chains only when the setting has drifted off the gateway,
 * which is what makes it usable as a self-heal from the launch wrapper as well as at install.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Overridable so the launch-time heal can be exercised against a scratch settings file.
// Namespaced: an un-prefixed CLAUDE_SETTINGS reads like a variable Claude Code owns, and this
// one aims a file mutation, so a collision would write ANTHROPIC_BASE_URL into someone else's
// JSON and record ITS value as the thing to restore at uninstall.
const SETTINGS = process.env.LIFELINE_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
const LIFELINE_HOME = process.env.LIFELINE_HOME ?? join(homedir(), ".lifeline");
const RECORD = join(LIFELINE_HOME, "settings-base-url.orig.json");

/**
 * Compare two URLs the way a server would. A trailing slash, a capital letter, stray
 * whitespace or the `localhost` spelling all name the SAME endpoint — and treating one of
 * those as a foreign proxy is how the gateway ends up chained to itself, forwarding every
 * request back into its own listener.
 */
function sameEndpoint(a, b) {
  const norm = (u) =>
    String(u ?? "")
      .replace(/\s+/g, "")
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace("//localhost:", "//127.0.0.1:");
  return norm(a) === norm(b);
}

/** Write JSON via a temp file: readers must never observe a truncated settings.json. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function loadSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    return null;
  }
}

function readRecordedOriginal() {
  try {
    return JSON.parse(readFileSync(RECORD, "utf8")).original ?? null;
  } catch {
    return null;
  }
}

const [mode, gatewayUrl] = process.argv.slice(2);

if (mode === "apply") {
  if (!gatewayUrl) {
    console.error("usage: patch-settings.mjs apply <gatewayUrl>");
    process.exit(2);
  }
  const settings = loadSettings();
  if (!settings) process.exit(0); // no settings file — nothing to chain
  const env = settings.env ?? {};
  const current = env.ANTHROPIC_BASE_URL ?? null;
  if (current !== null && sameEndpoint(current, gatewayUrl)) {
    console.log(readRecordedOriginal() ?? "");
    process.exit(0); // already chained (idempotent re-install)
  }
  mkdirSync(LIFELINE_HOME, { recursive: true });
  // Back up and record ONCE. Re-running this after the setting has drifted back to a proxy
  // must not overwrite the true pre-lifeline value with the drifted one; uninstall promises
  // to restore how it was, and "how it was" is whatever we saw first.
  const backup = join(LIFELINE_HOME, "settings.json.pre-lifeline.bak");
  if (!existsSync(backup)) copyFileSync(SETTINGS, backup);
  // The one exception to record-once: a record saying "there was nothing here" is not
  // evidence about a value the user set LATER. Without this upgrade, uninstall reads
  // original:null and DELETES a proxy added after install, whose only other copy is the
  // config.json it then tells the user to remove.
  const recorded = existsSync(RECORD) ? readRecordedOriginal() : undefined;
  if (recorded === undefined || (recorded === null && current !== null)) {
    writeJsonAtomic(RECORD, { original: current, recordedAt: Date.now() });
  }
  settings.env = { ...env, ANTHROPIC_BASE_URL: gatewayUrl };
  writeJsonAtomic(SETTINGS, settings);
  // Print what the gateway's upstream should now be: the value we just displaced. That is
  // the live routing, which is not always the recorded original (the user may have switched
  // proxies since install).
  console.log(current ?? "");
} else if (mode === "revert") {
  if (!existsSync(RECORD)) process.exit(0);
  const { original } = JSON.parse(readFileSync(RECORD, "utf8"));
  const settings = loadSettings();
  if (!settings) process.exit(0);
  const env = settings.env ?? {};
  if (original === null) delete env.ANTHROPIC_BASE_URL;
  else env.ANTHROPIC_BASE_URL = original;
  settings.env = env;
  writeJsonAtomic(SETTINGS, settings);
  console.log(original ?? "");
} else {
  console.error("usage: patch-settings.mjs apply <gatewayUrl> | revert");
  process.exit(2);
}
