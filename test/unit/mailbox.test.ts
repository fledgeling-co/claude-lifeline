import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyMailbox,
  enqueueItem,
  dequeueItem,
  claimNext,
  completeItem,
  pendingCount,
  sanitizeId,
  loadMailbox,
  saveMailbox,
  listMailboxes,
} from "../../src/queue/mailbox.js";

const NOW = 1_750_000_000_000;

describe("mailbox — pure item operations", () => {
  it("enqueue appends a pending item", () => {
    const { box, item } = enqueueItem(emptyMailbox("m", NOW), "do the thing", undefined, NOW, "id-1");
    expect(item.state).toBe("pending");
    expect(box.items).toHaveLength(1);
    expect(pendingCount(box)).toBe(1);
  });

  it("dequeue removes only a pending item", () => {
    let { box } = enqueueItem(emptyMailbox("m", NOW), "a", undefined, NOW, "id-1");
    const removed = dequeueItem(box, "id-1", NOW);
    expect(removed.outcome).toBe("removed");
    expect(removed.item?.state).toBe("removed");
    expect(pendingCount(removed.box)).toBe(0);
  });

  it("dequeue refuses a claimed (in-flight) item — no yanking running work", () => {
    let { box } = enqueueItem(emptyMailbox("m", NOW), "a", undefined, NOW, "id-1");
    box = claimNext(box, "agent-x", NOW).box;
    const result = dequeueItem(box, "id-1", NOW);
    expect(result.outcome).toBe("not-pending");
    expect(result.box.items[0]?.state).toBe("claimed");
  });

  it("dequeue matches by unique id prefix and reports not-found otherwise", () => {
    const { box } = enqueueItem(emptyMailbox("m", NOW), "a", undefined, NOW, "abcdef-123");
    expect(dequeueItem(box, "abcd", NOW).outcome).toBe("removed");
    expect(dequeueItem(box, "zzz", NOW).outcome).toBe("not-found");
  });

  it("claimNext takes the oldest pending item and drains to null", () => {
    let { box } = enqueueItem(emptyMailbox("m", NOW), "first", undefined, NOW, "id-1");
    box = enqueueItem(box, "second", undefined, NOW + 1, "id-2").box;
    const c1 = claimNext(box, "w", NOW + 2);
    expect(c1.item?.id).toBe("id-1");
    const c2 = claimNext(c1.box, "w", NOW + 3);
    expect(c2.item?.id).toBe("id-2");
    expect(claimNext(c2.box, "w", NOW + 4).item).toBeNull();
  });

  it("completeItem records the result and frees nothing else", () => {
    let { box } = enqueueItem(emptyMailbox("m", NOW), "a", undefined, NOW, "id-1");
    box = claimNext(box, "w", NOW).box;
    box = completeItem(box, "id-1", "done: shipped", NOW + 5);
    expect(box.items[0]?.state).toBe("done");
    expect(box.items[0]?.result).toBe("done: shipped");
  });

  it("enqueued-while-draining items are seen by a later claim (live mutation)", () => {
    let { box } = enqueueItem(emptyMailbox("m", NOW), "a", undefined, NOW, "id-1");
    const c1 = claimNext(box, "w", NOW);
    // A new item arrives while id-1 is in flight.
    const enq = enqueueItem(c1.box, "late arrival", undefined, NOW + 10, "id-2");
    const c2 = claimNext(enq.box, "w", NOW + 11);
    expect(c2.item?.id).toBe("id-2");
  });

  it("sanitizeId keeps ids path-safe and rejects empties", () => {
    expect(sanitizeId("my proj/run:1")).toBe("my-proj-run-1");
    expect(() => sanitizeId("..")).toThrow();
    expect(() => sanitizeId("///")).not.toThrow(); // becomes ---
  });
});

describe("mailbox — disk round-trip", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.LIFELINE_HOME;
    dir = null;
  });

  it("save/load round-trips and listMailboxes finds it", () => {
    dir = mkdtempSync(join(tmpdir(), "lifeline-mb-"));
    process.env.LIFELINE_HOME = dir;
    const { box } = enqueueItem(emptyMailbox("proj-x", NOW), "work", { k: 1 }, NOW, "id-1");
    saveMailbox(box);
    const loaded = loadMailbox("proj-x");
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]?.payload).toEqual({ k: 1 });
    expect(listMailboxes()).toContain("proj-x");
  });
});
