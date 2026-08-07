#!/usr/bin/env node
/**
 * Chain lifeline's gateway into ~/.claude/settings.json.
 *
 * Claude Code applies settings.json `env` itself, so a base URL there outranks anything
 * the wrapper exports. To chain claude -> gateway -> (existing proxy) -> API we must move
 * the settings value: the old value becomes the gateway's upstream, the settings value
 * becomes the gateway. The original is recorded under ~/.lifeline so revert is exact.
 *
 *   node patch-settings.mjs apply  <gatewayUrl>   prints the captured original (or "")
 *   node patch-settings.mjs revert                restores the recorded original
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS = join(homedir(), ".claude", "settings.json");
const LIFELINE_HOME = process.env.LIFELINE_HOME ?? join(homedir(), ".lifeline");
const RECORD = join(LIFELINE_HOME, "settings-base-url.orig.json");

function loadSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8"));
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
  const original = env.ANTHROPIC_BASE_URL ?? null;
  if (original === gatewayUrl) {
    console.log(original ?? "");
    process.exit(0); // already chained (idempotent re-install)
  }
  mkdirSync(LIFELINE_HOME, { recursive: true });
  copyFileSync(SETTINGS, join(LIFELINE_HOME, "settings.json.pre-lifeline.bak"));
  writeFileSync(RECORD, JSON.stringify({ original, recordedAt: Date.now() }, null, 2));
  settings.env = { ...env, ANTHROPIC_BASE_URL: gatewayUrl };
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log(original ?? "");
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
