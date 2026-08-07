/**
 * The template store: save a workflow script + inferred args schema under a name,
 * list, and materialize a run (Argo WorkflowTemplate registry shape; defaults = the
 * literals of the run the template came from).
 */
import { join, basename } from "node:path";
import { readdirSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { paths, claudeProjectsDir } from "../shared/paths.js";
import { readJson, writeJsonAtomic, ensureDir } from "../shared/io.js";
import { sanitizeId } from "../queue/mailbox.js";
import type { InferredSchema } from "./infer.js";
import { inferSchema, validateAgainst } from "./infer.js";

export interface TemplateMeta {
  name: string;
  description: string;
  argsSchema: InferredSchema | null; // null when the source run had no args
  argDefaults: unknown;
  source: { runId?: string; scriptPath: string };
  createdAt: number;
}

export function templatesDir(): string {
  return join(paths.home(), "templates");
}

export function templateDir(name: string): string {
  return join(templatesDir(), sanitizeId(name));
}

export interface SaveInput {
  scriptPath: string;
  name?: string;
  description?: string;
  args?: unknown;
  runId?: string;
}

/** Parse the `meta = {...}` block's name/description from a workflow script, textually. */
export function parseScriptMeta(source: string): { name: string | null; description: string | null } {
  const nameMatch = /meta\s*=\s*\{[^]*?name:\s*['"`]([^'"`]+)['"`]/.exec(source);
  const descMatch = /meta\s*=\s*\{[^]*?description:\s*['"`]([^'"`]+)['"`]/.exec(source);
  return { name: nameMatch?.[1] ?? null, description: descMatch?.[1] ?? null };
}

export function saveTemplate(input: SaveInput): TemplateMeta {
  const source = readFileSync(input.scriptPath, "utf8");
  const parsed = parseScriptMeta(source);
  const name = sanitizeId(input.name ?? parsed.name ?? basename(input.scriptPath, ".js"));
  const dir = templateDir(name);
  ensureDir(dir);
  copyFileSync(input.scriptPath, join(dir, "script.js"));
  const meta: TemplateMeta = {
    name,
    description: input.description ?? parsed.description ?? "",
    argsSchema: input.args === undefined ? null : inferSchema(input.args),
    argDefaults: input.args ?? null,
    source: { ...(input.runId ? { runId: input.runId } : {}), scriptPath: input.scriptPath },
    createdAt: Date.now(),
  };
  writeJsonAtomic(join(dir, "template.json"), meta);
  return meta;
}

export function listTemplates(): TemplateMeta[] {
  try {
    return readdirSync(templatesDir())
      .map((n) => readJson<TemplateMeta | null>(join(templatesDir(), n, "template.json"), null))
      .filter((m): m is TemplateMeta => m !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function loadTemplate(name: string): TemplateMeta | null {
  return readJson<TemplateMeta | null>(join(templateDir(name), "template.json"), null);
}

export interface MaterializedRun {
  scriptPath: string;
  args: unknown;
  validationErrors: string[];
  /** The exact instruction for the model: how to launch this via the Workflow tool. */
  invocation: string;
}

/**
 * Materialize a run: validate/merge args against the schema and return the exact
 * Workflow-tool call. Only the Claude Code model can invoke the Workflow tool, so the
 * output is the instruction, not a spawned process.
 */
export function materializeRun(name: string, args?: unknown): MaterializedRun | null {
  const meta = loadTemplate(name);
  if (!meta) return null;
  const scriptPath = join(templateDir(name), "script.js");
  const effectiveArgs = args === undefined ? meta.argDefaults : args;
  const validationErrors =
    meta.argsSchema && effectiveArgs !== null ? validateAgainst(meta.argsSchema, effectiveArgs) : [];
  const argsPart = effectiveArgs === null || effectiveArgs === undefined ? "" : `, args: ${JSON.stringify(effectiveArgs)}`;
  return {
    scriptPath,
    args: effectiveArgs,
    validationErrors,
    invocation: `Workflow({ scriptPath: ${JSON.stringify(scriptPath)}${argsPart} })`,
  };
}

// ── Mining: surface reusable templates from past runs ──────────────────────────────

export interface MinedCandidate {
  name: string;
  description: string;
  occurrences: number;
  newestScriptPath: string;
  newestMtime: number;
}

/**
 * Scan every persisted workflow script under ~/.claude/projects and cluster by meta.name.
 * A name that recurs across sessions is a workflow the user keeps rebuilding — the
 * signal that it deserves to be a saved template.
 */
export function mineTemplates(projectsDir = claudeProjectsDir()): MinedCandidate[] {
  const byName = new Map<string, MinedCandidate>();
  let scripts: string[] = [];
  try {
    scripts = readdirSync(projectsDir).flatMap((proj) => {
      const projDir = join(projectsDir, proj);
      try {
        return readdirSync(projDir).flatMap((session) => {
          const scriptsDir = join(projDir, session, "workflows", "scripts");
          try {
            return readdirSync(scriptsDir).filter((f) => f.endsWith(".js")).map((f) => join(scriptsDir, f));
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }

  for (const path of scripts) {
    let source: string;
    let mtime: number;
    try {
      source = readFileSync(path, "utf8");
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const { name, description } = parseScriptMeta(source);
    if (!name) continue;
    const existing = byName.get(name);
    if (existing) {
      existing.occurrences += 1;
      if (mtime > existing.newestMtime) {
        existing.newestMtime = mtime;
        existing.newestScriptPath = path;
        if (description) existing.description = description;
      }
    } else {
      byName.set(name, {
        name,
        description: description ?? "",
        occurrences: 1,
        newestScriptPath: path,
        newestMtime: mtime,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.occurrences - a.occurrences || b.newestMtime - a.newestMtime);
}
