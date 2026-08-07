import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Read a JSON file, returning `fallback` if missing or unparseable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically: write a temp sibling then rename over the target, so a reader
 * (the CLI, the UI) never sees a half-written file. rename is atomic within a filesystem.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
