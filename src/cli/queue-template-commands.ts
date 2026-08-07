/**
 * `lifeline queue` and `lifeline template` subcommand groups (Phase 2/3).
 * Same discipline as the rest of the CLI: this file owns logic, index.ts prints.
 */
import {
  loadMailbox,
  saveMailbox,
  enqueueItem,
  dequeueItem,
  listMailboxes,
  pendingCount,
  type Mailbox,
  type MailboxItem,
} from "../queue/mailbox.js";
import {
  saveTemplate,
  listTemplates,
  materializeRun,
  mineTemplates,
  type TemplateMeta,
  type MaterializedRun,
  type MinedCandidate,
  type SaveInput,
} from "../templates/store.js";
import { writeDrainScript } from "../templates/drain.js";

// ── queue ──────────────────────────────────────────────────────────────────────────

export interface EnqueueResult {
  ok: boolean;
  item?: MailboxItem;
  drainScriptPath?: string;
  pending?: number;
  error?: string;
}

export function enqueueCommand(mailboxId: string, prompt: string, payloadJson?: string): EnqueueResult {
  let payload: unknown;
  if (payloadJson !== undefined) {
    try {
      payload = JSON.parse(payloadJson);
    } catch (e) {
      return { ok: false, error: `--payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  try {
    const box = loadMailbox(mailboxId);
    const { box: updated, item } = enqueueItem(box, prompt, payload);
    saveMailbox(updated);
    // Keep the drain script current so "start draining" is always one Workflow call away.
    const drainScriptPath = writeDrainScript({ mailboxId });
    return { ok: true, item, drainScriptPath, pending: pendingCount(updated) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface DequeueResultOut {
  ok: boolean;
  outcome?: "removed" | "not-found" | "not-pending";
  item?: MailboxItem;
  error?: string;
}

export function dequeueCommand(mailboxId: string, itemId: string): DequeueResultOut {
  try {
    const box = loadMailbox(mailboxId);
    const result = dequeueItem(box, itemId);
    if (result.outcome === "removed") saveMailbox(result.box);
    return { ok: result.outcome === "removed", outcome: result.outcome, item: result.item };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface QueueListResult {
  mailboxes: Array<{ mailboxId: string; pending: number; total: number; box: Mailbox }>;
}

export function queueListCommand(mailboxId?: string): QueueListResult {
  const ids = mailboxId !== undefined ? [mailboxId] : listMailboxes();
  return {
    mailboxes: ids.map((id) => {
      const box = loadMailbox(id);
      return { mailboxId: id, pending: pendingCount(box), total: box.items.length, box };
    }),
  };
}

// ── template ───────────────────────────────────────────────────────────────────────

export function templateSaveCommand(input: SaveInput): { ok: boolean; meta?: TemplateMeta; error?: string } {
  try {
    return { ok: true, meta: saveTemplate(input) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function templateListCommand(): TemplateMeta[] {
  return listTemplates();
}

export function templateRunCommand(name: string, argsJson?: string): { ok: boolean; run?: MaterializedRun; error?: string } {
  let args: unknown;
  if (argsJson !== undefined) {
    try {
      args = JSON.parse(argsJson);
    } catch (e) {
      return { ok: false, error: `--args is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const run = materializeRun(name, args);
  if (!run) return { ok: false, error: `no template named "${name}" — see lifeline template list` };
  return { ok: true, run };
}

export function templateMineCommand(minOccurrences = 2): MinedCandidate[] {
  return mineTemplates().filter((c) => c.occurrences >= minOccurrences);
}
