#!/usr/bin/env node
/**
 * Replace Lifeline's configured upstream without retaining a Relay identity for the old route.
 *
 * The wrapper calls this whenever settings.json is re-chained. Keeping this operation in a
 * separately-tested script avoids a second, subtly different JSON writer in shell code.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const [configPath, upstream] = process.argv.slice(2);
if (!configPath || !upstream) {
  console.error("usage: update-gateway-upstream.mjs <config-path> <upstream>");
  process.exit(2);
}

let config = {};
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  // A malformed existing config is not ours to overwrite: callers treat this as a non-change.
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    config = {};
  } else {
    process.stdout.write("unreadable");
    process.exit(0);
  }
}

if (config.upstream === upstream) process.exit(0);

config.upstream = upstream;
// This marker is valid only when it names this exact upstream. The gateway will re-adopt it on
// restart only after independently confirming that the new route is Relay's persisted listener.
delete config.relayBridge;

const tempPath = `${configPath}.${process.pid}.tmp`;
writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n");
renameSync(tempPath, configPath);
process.stdout.write("changed");
