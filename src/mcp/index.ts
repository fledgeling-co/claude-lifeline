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

const transport = new StdioServerTransport();
await server.connect(transport);
