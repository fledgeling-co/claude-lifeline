#!/usr/bin/env node
/**
 * `lifeline` — the control surface over the gateway and the recovery daemon.
 *
 * This file owns argument parsing, printing and exit codes only. All behaviour lives in
 * commands.ts (logic) and render.ts (formatting).
 */

import { Command } from "commander";

import {
  controlCommand,
  defaultDeps,
  doctorCommand,
  statusCommand,
} from "./commands.js";
import {
  dequeueCommand,
  enqueueCommand,
  queueListCommand,
  templateListCommand,
  templateMineCommand,
  templateRunCommand,
  templateSaveCommand,
} from "./queue-template-commands.js";
import type { ControlIntent, ControlVerb } from "../shared/types.js";
import { ANSI, colorEnabled, paint, renderDoctor, renderStatus } from "./render.js";

const program = new Command();

program
  .name("lifeline")
  .description("Resilience and recovery layer for Claude Code workflows.")
  .version("0.1.0")
  .showHelpAfterError();

function useColor(colorFlag: boolean): boolean {
  return colorFlag && colorEnabled(process.env, process.stdout.isTTY === true);
}

/* ------------------------------------------------------------------ status */

program
  .command("status")
  .description("Show tracked runs and per-agent recovery state.")
  .option("--json", "emit the raw status snapshot as JSON")
  .option("--no-color", "disable ANSI colour")
  .action((opts: { json?: boolean; color: boolean }) => {
    const result = statusCommand(defaultDeps());

    if (opts.json === true) {
      console.log(JSON.stringify(result.snapshot, null, 2));
      return;
    }

    console.log(renderStatus(result.snapshot, { color: useColor(opts.color) }));
    if (result.message != null) {
      console.error(paint(result.message, ANSI.yellow, useColor(opts.color)));
    }
  });

/* ----------------------------------------------------- retry/pause/resume */

// The user-facing verbs only: `set-option` is a message the status window sends, not a command.
const CONTROL_HELP: Record<ControlVerb, string> = {
  retry: "Retry a run or a single agent (idempotent — retry is resume).",
  pause: "Pause a run or a single agent; stops new dispatch.",
  resume: "Resume a paused run or agent and trigger recovery.",
};

function registerControl(kind: ControlVerb): void {
  program
    .command(kind)
    .description(CONTROL_HELP[kind])
    .argument("<target>", "runId, or runId/agentId for a single agent")
    .option("--no-color", "disable ANSI colour")
    .action((target: string, opts: { color: boolean }) => {
      const color = useColor(opts.color);
      const result = controlCommand(kind, target, defaultDeps());

      if (!result.ok) {
        console.error(paint(`error: ${result.error ?? "unknown error"}`, ANSI.red, color));
        process.exitCode = 1;
        return;
      }

      const scope =
        result.target?.agentId == null
          ? `run ${result.target?.runId ?? target}`
          : `agent ${result.target.agentId} in run ${result.target.runId}`;
      console.log(`${paint(kind, ANSI.bold, color)} queued for ${scope}`);
      console.log(paint(`  intent ${result.file ?? ""}`, ANSI.grey, color));
    });
}

registerControl("retry");
registerControl("pause");
registerControl("resume");

/* ------------------------------------------------------------------ doctor */

program
  .command("doctor")
  .description("Check the gateway, the daemon, routing, and CLI version compatibility.")
  .option("--json", "emit the report as JSON")
  .option("--no-color", "disable ANSI colour")
  .action(async (opts: { json?: boolean; color: boolean }) => {
    const report = await doctorCommand(defaultDeps());

    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderDoctor(report, { color: useColor(opts.color) }));
    }

    // Warnings alone stay green-ish: only a hard failure is worth a non-zero exit.
    if (report.hardFailure) process.exitCode = 1;
  });

/* ------------------------------------------------------------- queue (Phase 2) */

const queue = program
  .command("queue")
  .description("Live queue mutation: enqueue/dequeue work for a running drain workflow.");

queue
  .command("add")
  .description("Enqueue a work item; a running drain workflow picks it up on its next poll.")
  .argument("<mailbox>", "mailbox id (any name; per-project or per-run)")
  .argument("<prompt>", "the work, phrased as a self-contained agent prompt")
  .option("--payload <json>", "optional structured JSON payload alongside the prompt")
  .action((mailbox: string, prompt: string, opts: { payload?: string }) => {
    const r = enqueueCommand(mailbox, prompt, opts.payload);
    if (!r.ok) {
      console.error(`error: ${r.error ?? "enqueue failed"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`enqueued ${r.item?.id} (${r.pending} pending in "${mailbox}")`);
    console.log(`drain workflow script: ${r.drainScriptPath}`);
    console.log(`start draining (in claude): Workflow({ scriptPath: ${JSON.stringify(r.drainScriptPath)} })`);
  });

queue
  .command("remove")
  .description("Dequeue a still-pending item before any agent claims it.")
  .argument("<mailbox>", "mailbox id")
  .argument("<itemId>", "item id (or unique prefix)")
  .action((mailbox: string, itemId: string) => {
    const r = dequeueCommand(mailbox, itemId);
    if (!r.ok) {
      console.error(
        r.outcome === "not-pending"
          ? `error: item is ${r.item?.state} — only pending items can be dequeued`
          : `error: ${r.error ?? r.outcome ?? "dequeue failed"}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`removed ${r.item?.id} from "${mailbox}"`);
  });

queue
  .command("list")
  .description("Show mailboxes and their items.")
  .argument("[mailbox]", "limit to one mailbox")
  .option("--json", "emit JSON")
  .action((mailbox: string | undefined, opts: { json?: boolean }) => {
    const r = queueListCommand(mailbox);
    if (opts.json === true) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.mailboxes.length === 0) {
      console.log("no mailboxes yet — lifeline queue add <mailbox> <prompt>");
      return;
    }
    for (const m of r.mailboxes) {
      console.log(`${m.mailboxId}  (${m.pending} pending / ${m.total} total)`);
      for (const item of m.box.items) {
        console.log(`  ${item.state.padEnd(8)} ${item.id.slice(0, 8)}  ${item.prompt.slice(0, 70)}`);
      }
    }
  });

/* ---------------------------------------------------------- template (Phase 3) */

const template = program
  .command("template")
  .description("Save, list, mine, and run reusable workflow templates.");

template
  .command("save")
  .description("Save a workflow script as a named template with an inferred args schema.")
  .argument("<scriptPath>", "path to a workflow script (e.g. from <session>/workflows/scripts/)")
  .option("--name <name>", "template name (defaults to the script's meta.name)")
  .option("--description <text>", "override the description")
  .option("--args <json>", "the concrete args of the source run; becomes schema + defaults")
  .option("--run-id <runId>", "record the source run id")
  .action((scriptPath: string, opts: { name?: string; description?: string; args?: string; runId?: string }) => {
    let args: unknown;
    if (opts.args !== undefined) {
      try {
        args = JSON.parse(opts.args);
      } catch (e) {
        console.error(`error: --args is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
        return;
      }
    }
    const r = templateSaveCommand({
      scriptPath,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    });
    if (!r.ok || !r.meta) {
      console.error(`error: ${r.error ?? "save failed"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`saved template "${r.meta.name}"${r.meta.description ? ` — ${r.meta.description}` : ""}`);
  });

template
  .command("list")
  .description("List saved templates.")
  .option("--json", "emit JSON")
  .action((opts: { json?: boolean }) => {
    const templates = templateListCommand();
    if (opts.json === true) {
      console.log(JSON.stringify(templates, null, 2));
      return;
    }
    if (templates.length === 0) {
      console.log("no templates yet — lifeline template save <script> or lifeline template mine");
      return;
    }
    for (const t of templates) {
      console.log(`${t.name.padEnd(28)} ${t.description.slice(0, 70)}`);
    }
  });

template
  .command("mine")
  .description("Scan past workflow runs for recurring scripts worth saving as templates.")
  .option("--min <n>", "minimum occurrences to report", "2")
  .option("--json", "emit JSON")
  .action((opts: { min: string; json?: boolean }) => {
    const candidates = templateMineCommand(Number(opts.min));
    if (opts.json === true) {
      console.log(JSON.stringify(candidates, null, 2));
      return;
    }
    if (candidates.length === 0) {
      console.log("no recurring workflow scripts found in ~/.claude/projects");
      return;
    }
    for (const c of candidates) {
      console.log(`${String(c.occurrences).padStart(3)}x  ${c.name.padEnd(32)} ${c.description.slice(0, 50)}`);
      console.log(`      save: lifeline template save ${JSON.stringify(c.newestScriptPath)} --name ${c.name}`);
    }
  });

template
  .command("run")
  .description("Materialize a template run: validated args + the exact Workflow call to paste into claude.")
  .argument("<name>", "template name")
  .option("--args <json>", "args for this run (defaults to the template's saved defaults)")
  .action((name: string, opts: { args?: string }) => {
    const r = templateRunCommand(name, opts.args);
    if (!r.ok || !r.run) {
      console.error(`error: ${r.error ?? "run failed"}`);
      process.exitCode = 1;
      return;
    }
    if (r.run.validationErrors.length > 0) {
      console.error("args do not match the template's schema:");
      for (const e of r.run.validationErrors) console.error(`  ${e}`);
      process.exitCode = 1;
      return;
    }
    console.log(`script: ${r.run.scriptPath}`);
    console.log(`invoke (in claude): ${r.run.invocation}`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const color = colorEnabled(process.env, process.stderr.isTTY === true);
  console.error(paint(`lifeline: ${err instanceof Error ? err.message : String(err)}`, ANSI.red, color));
  process.exitCode = 1;
});
