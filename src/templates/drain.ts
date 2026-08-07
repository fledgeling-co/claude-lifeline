/**
 * Generate a mailbox-drain workflow script.
 *
 * Workflow scripts cannot touch the filesystem, but their agents can — so the generated
 * script loops: one agent claims the oldest pending mailbox item (editing the mailbox
 * file), a second executes the item's prompt, and the loop exits after `emptyRounds`
 * consecutive empty reads (loop-until-dry, so items enqueued while the run is live are
 * picked up). This is what makes `lifeline enqueue` a LIVE mutation: start the drain
 * workflow once, then feed it work as it arrives instead of building a new workflow
 * per batch.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { mailboxFile, sanitizeId } from "../queue/mailbox.js";
import { templateDir } from "./store.js";
import { ensureDir } from "../shared/io.js";

export interface DrainScriptOptions {
  mailboxId: string;
  /** Consecutive empty polls before the run ends. Default 2. */
  emptyRounds?: number;
  /** Max items processed in one run (runaway backstop). Default 100. */
  maxItems?: number;
}

export function generateDrainScript(opts: DrainScriptOptions): string {
  const mailboxId = sanitizeId(opts.mailboxId);
  const file = mailboxFile(mailboxId);
  const emptyRounds = opts.emptyRounds ?? 2;
  const maxItems = opts.maxItems ?? 100;

  // The generated source is plain JS for the Workflow sandbox: no fs, no Date.now —
  // agents do all I/O, and item ids (not timestamps) index the work.
  return `export const meta = {
  name: 'lifeline-drain-${mailboxId}',
  description: 'Drain the lifeline mailbox "${mailboxId}": execute enqueued items as agents until the queue stays empty',
  phases: [
    { title: 'Drain', detail: 'claim next pending item, execute it, repeat until dry' },
  ],
}

const MAILBOX = ${JSON.stringify(file)}
const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    id: { type: 'string' },
    prompt: { type: 'string' },
  },
  required: ['found'],
}

phase('Drain')
const results = []
let empty = 0
let processed = 0
while (empty < ${emptyRounds} && processed < ${maxItems}) {
  // Agent 1: claim. Editing the mailbox file needs tools, which agents have and this script does not.
  const claim = await agent(
    'You are the lifeline mailbox claim step. Read the JSON file at ' + MAILBOX + ' . ' +
    'Find the FIRST item in .items whose state is "pending". If none exists, return {found:false}. ' +
    'Otherwise set that item state to "claimed", set claimedBy to "workflow-drain", update its updatedAt ' +
    'to the current epoch ms, write the file back (pretty-printed JSON), and return {found:true, id, prompt} ' +
    'for that item. Change nothing else in the file.',
    { label: 'claim-next', schema: CLAIM_SCHEMA, effort: 'low' }
  )
  if (!claim || !claim.found) { empty += 1; continue }
  empty = 0
  processed += 1

  // Agent 2: execute the enqueued work as its own prompt.
  const outcome = await agent(
    claim.prompt +
    '\\n\\nWhen finished, your final text is the result record for lifeline mailbox item ' + claim.id + '.',
    { label: 'item:' + claim.id.slice(0, 8) }
  )

  // Agent 3 (cheap): mark done with the result summary.
  await agent(
    'Read the JSON file at ' + MAILBOX + ' , find the item with id "' + claim.id + '", set its state to "done", ' +
    'set its result to the following text (truncate to 2000 chars), update updatedAt, and write the file back: ' +
    '\\n\\n' + String(outcome ?? '(agent returned null — the item may need re-enqueueing)').slice(0, 2000),
    { label: 'complete:' + claim.id.slice(0, 8), effort: 'low' }
  )
  results.push({ id: claim.id, ok: outcome !== null })
}

return { mailbox: ${JSON.stringify(mailboxId)}, processed, results }
`;
}

/** Write the drain script for a mailbox under the templates tree; returns its path. */
export function writeDrainScript(opts: DrainScriptOptions): string {
  const dir = templateDir(`mailbox-${opts.mailboxId}`);
  ensureDir(dir);
  const path = join(dir, "drain.js");
  writeFileSync(path, generateDrainScript(opts), "utf8");
  return path;
}
