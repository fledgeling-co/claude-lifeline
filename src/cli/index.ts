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
import type { ControlIntent } from "../shared/types.js";
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

const CONTROL_HELP: Record<ControlIntent["kind"], string> = {
  retry: "Retry a run or a single agent (idempotent — retry is resume).",
  pause: "Pause a run or a single agent; stops new dispatch.",
  resume: "Resume a paused run or agent and trigger recovery.",
};

function registerControl(kind: ControlIntent["kind"]): void {
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const color = colorEnabled(process.env, process.stderr.isTTY === true);
  console.error(paint(`lifeline: ${err instanceof Error ? err.message : String(err)}`, ANSI.red, color));
  process.exitCode = 1;
});
