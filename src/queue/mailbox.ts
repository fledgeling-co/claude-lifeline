/**
 * The mailbox: lifeline's live queue-mutation channel (Phase 2).
 *
 * Workflow scripts run in a sandbox with no filesystem access, but the agents they
 * spawn have full tools — so the mailbox is a file that a drain-loop workflow's agents
 * read and claim between items (the actor-mailbox model: append-only intent, serialized
 * consumption at step boundaries; see docs/research §1.3). Enqueue adds a pending item
 * (a fresh prompt = a fresh cache key, so replay semantics are untouched); dequeue marks
 * a still-pending item removed before any agent claims it. An in-flight (claimed) item
 * cannot be dequeued — that would need abort semantics no surveyed system offers.
 */
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { paths } from "../shared/paths.js";
import { readJson, writeJsonAtomic, ensureDir } from "../shared/io.js";

export type MailboxItemState = "pending" | "claimed" | "done" | "removed";

export interface MailboxItem {
  id: string;
  /** The work, phrased as a self-contained agent prompt. */
  prompt: string;
  /** Optional structured payload templated workflows may interpret instead of prompt. */
  payload?: unknown;
  state: MailboxItemState;
  enqueuedAt: number;
  updatedAt: number;
  /** Set when claimed/done: which agent/run took it. */
  claimedBy?: string;
  result?: string;
}

export interface Mailbox {
  mailboxId: string;
  items: MailboxItem[];
  createdAt: number;
  updatedAt: number;
}

export function mailboxDir(): string {
  return join(paths.home(), "mailbox");
}

export function mailboxFile(mailboxId: string): string {
  return join(mailboxDir(), `${sanitizeId(mailboxId)}.json`);
}

/** Mailbox ids come from CLI/MCP input and become filenames — keep them path-safe. */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    throw new Error(`invalid mailbox id: ${JSON.stringify(id)}`);
  }
  return cleaned;
}

export function emptyMailbox(mailboxId: string, now = Date.now()): Mailbox {
  return { mailboxId: sanitizeId(mailboxId), items: [], createdAt: now, updatedAt: now };
}

export function loadMailbox(mailboxId: string): Mailbox {
  return readJson<Mailbox>(mailboxFile(mailboxId), emptyMailbox(mailboxId));
}

export function saveMailbox(box: Mailbox): void {
  ensureDir(mailboxDir());
  writeJsonAtomic(mailboxFile(box.mailboxId), box);
}

export function listMailboxes(): string[] {
  try {
    return readdirSync(mailboxDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

// ── Pure item operations (tested without disk) ─────────────────────────────────────

export function enqueueItem(
  box: Mailbox,
  prompt: string,
  payload?: unknown,
  now = Date.now(),
  id = randomUUID(),
): { box: Mailbox; item: MailboxItem } {
  const item: MailboxItem = {
    id,
    prompt,
    ...(payload === undefined ? {} : { payload }),
    state: "pending",
    enqueuedAt: now,
    updatedAt: now,
  };
  return { box: { ...box, items: [...box.items, item], updatedAt: now }, item };
}

export interface DequeueResult {
  box: Mailbox;
  outcome: "removed" | "not-found" | "not-pending";
  item?: MailboxItem;
}

/** Dequeue only removes an item nothing has claimed yet — in-flight work is not yanked. */
export function dequeueItem(box: Mailbox, itemId: string, now = Date.now()): DequeueResult {
  const item = box.items.find((i) => i.id === itemId || i.id.startsWith(itemId));
  if (!item) return { box, outcome: "not-found" };
  if (item.state !== "pending") return { box, outcome: "not-pending", item };
  const updated: MailboxItem = { ...item, state: "removed", updatedAt: now };
  return {
    box: { ...box, items: box.items.map((i) => (i.id === item.id ? updated : i)), updatedAt: now },
    outcome: "removed",
    item: updated,
  };
}

/** Claim the oldest pending item (what a drain agent does). Returns null when drained. */
export function claimNext(box: Mailbox, claimedBy: string, now = Date.now()): { box: Mailbox; item: MailboxItem | null } {
  const next = box.items.find((i) => i.state === "pending");
  if (!next) return { box, item: null };
  const claimed: MailboxItem = { ...next, state: "claimed", claimedBy, updatedAt: now };
  return {
    box: { ...box, items: box.items.map((i) => (i.id === next.id ? claimed : i)), updatedAt: now },
    item: claimed,
  };
}

export function completeItem(box: Mailbox, itemId: string, result: string, now = Date.now()): Mailbox {
  return {
    ...box,
    items: box.items.map((i) => (i.id === itemId ? { ...i, state: "done" as const, result, updatedAt: now } : i)),
    updatedAt: now,
  };
}

export function pendingCount(box: Mailbox): number {
  return box.items.filter((i) => i.state === "pending").length;
}
