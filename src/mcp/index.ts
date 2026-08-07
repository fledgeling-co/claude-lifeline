#!/usr/bin/env node
/**
 * lifeline MCP server (Seam C, v1 surface).
 *
 * This is how the Claude Code model itself learns lifeline exists: the tool
 * descriptions below are the contract. The tools read the daemon's status snapshot
 * and write control intents; the daemon (lifelined) does the actual work. Keeping
 * this process stateless means a wedged MCP server can never corrupt recovery state.
 *
 * v1 exposes status / retry / pause / resume. Enqueue/dequeue and templating tools
 * arrive with their phases (docs/plans/PLAN.md §7).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../shared/paths.js";
import { readJson, writeJsonAtomic, ensureDir } from "../shared/io.js";
import type { ControlIntent, StatusSnapshot } from "../shared/types.js";
import {
  dequeueCommand,
  enqueueCommand,
  queueListCommand,
  templateListCommand,
  templateMineCommand,
  templateRunCommand,
  templateSaveCommand,
} from "../cli/queue-template-commands.js";

function readSnapshot(): StatusSnapshot | null {
  return readJson<StatusSnapshot | null>(paths.status(), null);
}

function writeIntent(kind: ControlIntent["kind"], runId: string, agentId?: string | null): ControlIntent {
  const intent: ControlIntent = {
    id: randomUUID(),
    kind,
    target: { runId, agentId: agentId ?? null },
    createdAt: Date.now(),
  };
  ensureDir(paths.intentsDir());
  writeJsonAtomic(join(paths.intentsDir(), `${intent.id}.json`), intent);
  return intent;
}

function daemonFreshness(): { running: boolean; ageMs: number | null } {
  try {
    const age = Date.now() - statSync(paths.status()).mtimeMs;
    return { running: age < 60_000, ageMs: age };
  } catch {
    return { running: false, ageMs: null };
  }
}

const server = new McpServer({ name: "lifeline", version: "0.1.0" });

server.registerTool(
  "lifeline_status",
  {
    description:
      "Report the live recovery state of every Claude Code workflow run lifeline is protecting. " +
      "lifeline auto-retries failed workflow agents (rate limits, 5xx overload, connectivity errors) with " +
      "exponential backoff up to 30 attempts, parks agents hit by usage/session limits and retries them on a " +
      "schedule, and auto-pauses runs when the network drops (auto-resuming when it returns). Use this to see " +
      "per-agent states — retrying (k/30), paused (offline | usage limit | manual), failed (terminal), done — " +
      "and run-level rollups where an agent failure with live siblings is a WARNING, and only a whole-run " +
      "failure is an error ('completed_with_failures' is distinct from 'completed'). Call it when a workflow " +
      "reports completed but work seems missing, when agents show red crosses, or before relaunching any " +
      "workflow — a run lifeline is already recovering should not be relaunched by hand.",
    inputSchema: {
      runId: z.string().optional().describe("Limit the report to one workflow run id (wf_...)."),
    },
  },
  async ({ runId }) => {
    const snap = readSnapshot();
    const daemon = daemonFreshness();
    if (!snap) {
      return {
        content: [
          {
            type: "text",
            text: `No lifeline status snapshot found${daemon.running ? "" : " and the daemon looks stopped"}. Run 'lifeline doctor' in a terminal.`,
          },
        ],
      };
    }
    const runs = runId ? snap.runs.filter((r) => r.runId === runId) : snap.runs;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ updatedAt: snap.updatedAt, online: snap.online, daemon, runs }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "lifeline_retry",
  {
    description:
      "Retry (equivalently: resume) a failed workflow agent or a whole workflow run — the single action that " +
      "clears a red cross. Idempotent and no-op-safe: retrying something already recovered or still healthy " +
      "changes nothing, so it is always safe to press. lifeline schedules the retry through its ledger " +
      "(exponential backoff, 30-attempt cap, usage-limit-aware), relocates the run journal so the resume " +
      "actually finds its cache, and reconciles cached 'merged' claims against git before trusting them. " +
      "Prefer this over re-running a workflow script by hand: a manual relaunch cold-starts and re-pays for " +
      "work the journal already holds.",
    inputSchema: {
      runId: z.string().describe("The workflow run id (wf_...)."),
      agentId: z.string().optional().describe("A specific agent id within the run; omit to retry every failed agent in the run."),
    },
  },
  async ({ runId, agentId }) => {
    const intent = writeIntent("retry", runId, agentId);
    return {
      content: [
        {
          type: "text",
          text: `Retry intent ${intent.id} queued for ${agentId ? `agent ${agentId} in ` : ""}run ${runId}. The lifeline daemon will schedule recovery; check lifeline_status for progress.`,
        },
      ],
    };
  },
);

server.registerTool(
  "lifeline_pause",
  {
    description:
      "Pause a single workflow agent, or a whole workflow run (which pauses all of its subagents). Pausing " +
      "stops lifeline from dispatching new recovery attempts; an in-flight LLM call is not killed mid-request " +
      "(the pause gates future scheduling, matching how Temporal/Prefect pause). Use it to hold recovery while " +
      "you investigate, before editing a workflow script, or to stop burning retry budget deliberately. " +
      "lifeline also auto-pauses on connectivity loss and usage limits without being asked.",
    inputSchema: {
      runId: z.string().describe("The workflow run id (wf_...)."),
      agentId: z.string().optional().describe("A specific agent id; omit to pause the whole run and all its subagents."),
    },
  },
  async ({ runId, agentId }) => {
    const intent = writeIntent("pause", runId, agentId);
    return {
      content: [
        {
          type: "text",
          text: `Pause intent ${intent.id} queued for ${agentId ? `agent ${agentId} in ` : ""}run ${runId}.`,
        },
      ],
    };
  },
);

server.registerTool(
  "lifeline_resume",
  {
    description:
      "Resume a paused workflow agent or a whole paused workflow run (all subagents). Clears a manual pause " +
      "and re-enables scheduled recovery immediately; for offline or usage-limit pauses lifeline resumes on " +
      "its own when the network returns or the limit frees, so manual resume is only needed to jump the " +
      "queue. Same single action as lifeline_retry under the hood — retry and resume are one operation.",
    inputSchema: {
      runId: z.string().describe("The workflow run id (wf_...)."),
      agentId: z.string().optional().describe("A specific agent id; omit to resume the whole run."),
    },
  },
  async ({ runId, agentId }) => {
    const intent = writeIntent("resume", runId, agentId);
    return {
      content: [
        {
          type: "text",
          text: `Resume intent ${intent.id} queued for ${agentId ? `agent ${agentId} in ` : ""}run ${runId}.`,
        },
      ],
    };
  },
);

server.registerTool(
  "lifeline_enqueue",
  {
    description:
      "Add a work item to a lifeline mailbox — live queue mutation for workflows. Instead of tearing down " +
      "and rebuilding a workflow when new work arrives, enqueue the item (as a self-contained agent prompt) " +
      "and a running drain workflow picks it up on its next poll; if no drain workflow is running, this tool " +
      "returns the exact Workflow call to start one (a loop-until-dry script whose agents claim and execute " +
      "items). New items get fresh cache keys, so enqueueing never disturbs an existing run's replay. Use a " +
      "stable mailbox id per project or stream of work.",
    inputSchema: {
      mailbox: z.string().describe("Mailbox id — any stable name, e.g. the project or campaign."),
      prompt: z.string().describe("The work item, phrased as a self-contained agent prompt."),
      payload: z.string().optional().describe("Optional JSON string payload stored alongside the prompt."),
    },
  },
  async ({ mailbox, prompt, payload }) => {
    const r = enqueueCommand(mailbox, prompt, payload);
    if (!r.ok) return { content: [{ type: "text", text: `enqueue failed: ${r.error}` }], isError: true };
    return {
      content: [
        {
          type: "text",
          text:
            `Enqueued ${r.item?.id} (${r.pending} pending in "${mailbox}").\n` +
            `If no drain workflow is currently running for this mailbox, start one with:\n` +
            `Workflow({ scriptPath: ${JSON.stringify(r.drainScriptPath)} })`,
        },
      ],
    };
  },
);

server.registerTool(
  "lifeline_dequeue",
  {
    description:
      "Remove a still-pending item from a lifeline mailbox before any agent claims it — the safe half of " +
      "live queue mutation. An item that is already claimed (in flight) or done cannot be dequeued; that " +
      "would require yanking a running agent, which no orchestration system does safely. Check " +
      "lifeline_queue_list first for item ids and states.",
    inputSchema: {
      mailbox: z.string().describe("Mailbox id."),
      itemId: z.string().describe("Item id (or unique id prefix) to remove."),
    },
  },
  async ({ mailbox, itemId }) => {
    const r = dequeueCommand(mailbox, itemId);
    const text = r.ok
      ? `Removed ${r.item?.id} from "${mailbox}".`
      : r.outcome === "not-pending"
        ? `Cannot dequeue: item is ${r.item?.state}; only pending items can be removed.`
        : `Dequeue failed: ${r.error ?? r.outcome}`;
    return { content: [{ type: "text", text }], ...(r.ok ? {} : { isError: true }) };
  },
);

server.registerTool(
  "lifeline_queue_list",
  {
    description:
      "List lifeline mailboxes and their items (pending / claimed / done / removed) — the state of live " +
      "queue mutation. Use before dequeueing, or to check whether enqueued work has been picked up by a " +
      "drain workflow.",
    inputSchema: {
      mailbox: z.string().optional().describe("Limit to one mailbox id."),
    },
  },
  async ({ mailbox }) => {
    const r = queueListCommand(mailbox);
    return { content: [{ type: "text", text: JSON.stringify(r.mailboxes, null, 2) }] };
  },
);

server.registerTool(
  "lifeline_template_list",
  {
    description:
      "List saved lifeline workflow templates — reusable, parameterised workflow scripts with an inferred " +
      "JSON-schema for their args and defaults from the run they were saved from. Prefer running a saved " +
      "template over rebuilding a similar workflow script from scratch.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: JSON.stringify(templateListCommand(), null, 2) }] }),
);

server.registerTool(
  "lifeline_template_save",
  {
    description:
      "Save a workflow script as a named reusable template. Pass the script path (every Workflow invocation " +
      "persists its script under <session>/workflows/scripts/) and, when known, the run's args JSON — the " +
      "args become a validated schema with defaults, so future runs are parameterised instead of copy-pasted. " +
      "Use lifeline_template_mine to find recurring scripts worth saving.",
    inputSchema: {
      scriptPath: z.string().describe("Path to the workflow script file."),
      name: z.string().optional().describe("Template name; defaults to the script's meta.name."),
      description: z.string().optional(),
      args: z.string().optional().describe("The source run's args as a JSON string; becomes schema + defaults."),
      runId: z.string().optional().describe("Source run id, for provenance."),
    },
  },
  async ({ scriptPath, name, description, args, runId }) => {
    let parsedArgs: unknown;
    if (args !== undefined) {
      try {
        parsedArgs = JSON.parse(args);
      } catch (e) {
        return { content: [{ type: "text", text: `args is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
    const r = templateSaveCommand({
      scriptPath,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(parsedArgs !== undefined ? { args: parsedArgs } : {}),
      ...(runId !== undefined ? { runId } : {}),
    });
    if (!r.ok || !r.meta) return { content: [{ type: "text", text: `save failed: ${r.error}` }], isError: true };
    return { content: [{ type: "text", text: `Saved template "${r.meta.name}". Run it with lifeline_template_run.` }] };
  },
);

server.registerTool(
  "lifeline_template_run",
  {
    description:
      "Materialize a saved template into a runnable workflow: validates the given args against the " +
      "template's schema (falling back to its saved defaults) and returns the exact Workflow tool call to " +
      "invoke. This tool does not start the run itself — invoke the returned Workflow(...) call to launch it.",
    inputSchema: {
      name: z.string().describe("Template name from lifeline_template_list."),
      args: z.string().optional().describe("Args for this run as a JSON string; omit to use the saved defaults."),
    },
  },
  async ({ name, args }) => {
    const r = templateRunCommand(name, args);
    if (!r.ok || !r.run) return { content: [{ type: "text", text: `run failed: ${r.error}` }], isError: true };
    if (r.run.validationErrors.length > 0) {
      return {
        content: [{ type: "text", text: `args do not match the template schema:\n${r.run.validationErrors.join("\n")}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Template "${name}" is ready. Launch it by invoking:\n${r.run.invocation}`,
        },
      ],
    };
  },
);

server.registerTool(
  "lifeline_template_mine",
  {
    description:
      "Scan every persisted workflow script under ~/.claude/projects and surface recurring ones (clustered " +
      "by meta.name) — workflows the user keeps rebuilding that deserve to be saved as templates. Returns " +
      "each candidate with its occurrence count and newest script path, ready for lifeline_template_save.",
    inputSchema: {
      minOccurrences: z.number().int().min(1).optional().describe("Minimum occurrences to report (default 2)."),
    },
  },
  async ({ minOccurrences }) => {
    const candidates = templateMineCommand(minOccurrences ?? 2);
    return { content: [{ type: "text", text: JSON.stringify(candidates.slice(0, 40), null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
