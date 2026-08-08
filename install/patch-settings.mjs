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
 *   node patch-settings.mjs current               prints the live settings value (or "")
 *
 * `apply` is safe to re-run: it chains only when the setting has drifted off the gateway,
 * which is what makes it usable as a self-heal from the launch wrapper as well as at install.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Overridable so the launch-time heal can be exercised against a scratch settings file.
const SETTINGS = process.env.CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
const LIFELINE_HOME = process.env.LIFELINE_HOME ?? join(homedir(), ".lifeline");
const RECORD = join(LIFELINE_HOME, "settings-base-url.orig.json");

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

if (mode === "current") {
  const settings = loadSettings();
  console.log(settings?.env?.ANTHROPIC_BASE_URL ?? "");
  process.exit(0);
}

if (mode === "apply") {
  if (!gatewayUrl) {
    console.error("usage: patch-settings.mjs apply <gatewayUrl>");
    process.exit(2);
  }
  const settings = loadSettings();
  if (!settings) process.exit(0); // no settings file — nothing to chain
  const env = settings.env ?? {};
  const current = env.ANTHROPIC_BASE_URL ?? null;
  if (current === gatewayUrl) {
    console.log(readRecordedOriginal() ?? "");
    process.exit(0); // already chained (idempotent re-install)
  }
  mkdirSync(LIFELINE_HOME, { recursive: true });
  // Back up and record ONCE. Re-running this after the setting has drifted back to a proxy
  // must not overwrite the true pre-lifeline value with the drifted one; uninstall promises
  // to restore how it was, and "how it was" is whatever we saw first.
  const backup = join(LIFELINE_HOME, "settings.json.pre-lifeline.bak");
  if (!existsSync(backup)) copyFileSync(SETTINGS, backup);
  if (!existsSync(RECORD)) {
    writeFileSync(RECORD, JSON.stringify({ original: current, recordedAt: Date.now() }, null, 2));
  }
  settings.env = { ...env, ANTHROPIC_BASE_URL: gatewayUrl };
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
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
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log(original ?? "");
} else {
  console.error("usage: patch-settings.mjs apply <gatewayUrl> | revert");
  process.exit(2);
}
