import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, now, uuid } from "../src/db.js";

// The model is stubbed: each runTurn parks on a gate the test controls, so
// queue/turn state is inspectable mid-flight instead of racing a fake network.
type Call = { turnId: string; text: string | null };
const calls: Call[] = [];
let gate: (() => void) | null = null;

vi.mock("../src/model.js", () => ({
  runTurn: async (
    _model: unknown,
    messages: { role: string; content: string }[],
    _tools: unknown,
    ctx: { turnId: string },
    cb: { onItem: (i: { kind: string; role?: string; content: unknown }) => void }
  ) => {
    calls.push({ turnId: ctx.turnId, text: messages.at(-1)?.content ?? null });
    await new Promise<void>((resolve) => {
      gate = resolve;
    });
    cb.onItem({ kind: "message", role: "hoot", content: { text: "ok" } });
    return "ok";
  },
}));

let turns: typeof import("../src/turns.js");
let pellet: typeof import("../src/pellet.js");

const hootId = uuid();
const threadId = uuid();

function seedHoot() {
  db.prepare(
    `INSERT INTO hoots (id, name, status, model_base_url, model_name, model_params, system_prompt, created_at)
     VALUES (?, 'Juniper', 'active', 'http://127.0.0.1:1/v1', 'test-model', NULL, 'you are juniper', ?)`
  ).run(hootId, now());
  db.prepare(
    `INSERT INTO threads (id, hoot_id, kind, title, status, created_at, updated_at)
     VALUES (?, ?, 'bough', NULL, 'open', ?, ?)`
  ).run(threadId, hootId, now(), now());
}

/** Let the async turn pipeline run until the stub has been entered again. */
async function untilStubbed() {
  await vi.waitFor(() => {
    if (!gate) throw new Error("stub not entered yet");
  });
}

/** Release the in-flight stub call and settle the pipeline. */
async function release() {
  await untilStubbed();
  const g = gate;
  gate = null;
  g!();
  await new Promise((r) => setTimeout(r, 20));
}

beforeAll(async () => {
  turns = await import("../src/turns.js");
  pellet = await import("../src/pellet.js");
});

beforeEach(() => {
  db.exec("DELETE FROM queued_turns; DELETE FROM items; DELETE FROM turns; DELETE FROM threads; DELETE FROM facts; DELETE FROM hoots;");
  db.exec("DELETE FROM meta");
  calls.length = 0;
  gate = null;
  seedHoot();
});

describe("turn queueing (DECISIONS #6: the composer never blocks)", () => {
  it("accepts the first turn and queues the second instead of rejecting it", async () => {
    const first = await turns.startTurn({ threadId, trigger: "user", message: "one" });
    expect(first.queued).toBe(false);
    expect(first.turnId).not.toBe("");
    await untilStubbed();

    const second = await turns.startTurn({ threadId, trigger: "user", message: "two" });
    expect(second.queued).toBe(true);
    expect(second.turnId).toBe("");

    // Still one in-flight turn, one turn row, and one queue row.
    expect((db.prepare("SELECT COUNT(*) n FROM turns").get() as any).n).toBe(1);
    const queued = db.prepare("SELECT ended FROM (SELECT message AS ended FROM queued_turns)").all() as any[];
    expect(queued.map((q) => q.ended)).toEqual(["two"]);
  });

  it("never surfaces busy as an error to a second sender", async () => {
    await turns.startTurn({ threadId, trigger: "user", message: "one" });
    await untilStubbed();
    await expect(turns.startTurn({ threadId, trigger: "user", message: "two" })).resolves.toMatchObject({
      queued: true,
    });
  });

  it("drains the queue into a real turn once the first one lands", async () => {
    await turns.startTurn({ threadId, trigger: "user", message: "one" });
    await turns.startTurn({ threadId, trigger: "user", message: "two" }).catch(() => {});
    // (startTurn awaited while busy → queued path; no gate wait needed)
    await release();

    await vi.waitFor(() => {
      expect(calls.length).toBe(2);
    });
    // The queued turn started with the queued message as its newest user input.
    expect(calls[1].text).toBe("two");
    // Draining deletes the queue row.
    expect((db.prepare("SELECT COUNT(*) n FROM queued_turns").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM turns").get() as any).n).toBe(2);

    await release();
  });

  it("deletes a queued turn so it never runs", async () => {
    await turns.startTurn({ threadId, trigger: "user", message: "one" });
    await untilStubbed();
    await turns.startTurn({ threadId, trigger: "user", message: "two" });

    db.prepare("DELETE FROM queued_turns WHERE thread_id = ?").run(threadId);
    await release();

    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM turns").get() as any).n).toBe(1);
  });
});

describe("reconcileTurns", () => {
  it("interrupts turns left in_progress by a restart and reports the count", async () => {
    const stuckId = uuid();
    db.prepare(
      `INSERT INTO turns (id, thread_id, status, trigger, started_at, origin_surface)
       VALUES (?, ?, 'in_progress', 'user', ?, 'web')`
    ).run(stuckId, threadId, now());

    expect(turns.reconcileTurns()).toBe(1);

    const row = db.prepare("SELECT status, error, completed_at FROM turns WHERE id = ?").get(stuckId) as any;
    expect(row.status).toBe("interrupted");
    expect(row.error).toContain("restarted");
    expect(row.completed_at).not.toBeNull();

    // Idempotent: nothing left to reconcile.
    expect(turns.reconcileTurns()).toBe(0);
  });

  it("leaves completed turns alone", async () => {
    const doneId = uuid();
    db.prepare(
      `INSERT INTO turns (id, thread_id, status, trigger, started_at, completed_at, origin_surface)
       VALUES (?, ?, 'completed', 'user', ?, ?, 'web')`
    ).run(doneId, threadId, now(), now());

    expect(turns.reconcileTurns()).toBe(0);
    expect((db.prepare("SELECT status FROM turns WHERE id = ?").get(doneId) as any).status).toBe("completed");
  });
});

describe("pelletContextBlock fact scoping (DECISIONS #13)", () => {
  const otherHoot = uuid();

  function fact(hoot: string, text: string, scope: "hoot" | "global", forgotten = false) {
    db.prepare(
      `INSERT INTO facts (id, hoot_id, text, category, scope, source_item_id, confidence, created_at, forgotten_at)
       VALUES (?, ?, ?, 'other', ?, NULL, 'confirmed', ?, ?)`
    ).run(uuid(), hoot, text, scope, now(), forgotten ? now() : null);
  }

  beforeEach(() => {
    db.prepare(
      `INSERT INTO hoots (id, name, status, model_base_url, model_name, model_params, system_prompt, created_at)
       VALUES (?, 'Brian', 'active', 'http://127.0.0.1:1/v1', 'test-model', NULL, '', ?)`
    ).run(otherHoot, now());

    fact(hootId, "own fact", "hoot");
    fact(hootId, "shared fact", "global");
    fact(hootId, "forgotten fact", "hoot", true);
    fact(otherHoot, "other hoot fact", "hoot");
  });

  it("includes this hoot's facts and global facts only", () => {
    const block = pellet.pelletContextBlock(hootId);

    expect(block).toContain("own fact");
    expect(block).toContain("shared fact");
    expect(block).not.toContain("other hoot fact");
    expect(block).not.toContain("forgotten fact");
  });

  it("renders facts as a bullet list ahead of the summary", () => {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)`
    ).run(pellet.pelletKey(hootId), JSON.stringify({ facts: [], summary: "we talked about owls", generated_at: 1, cursor_item_id: null }));

    const block = pellet.pelletContextBlock(hootId);
    expect(block).toContain("Long-term memory:\n- ");
    expect(block).toContain("Summary of our history: we talked about owls");
    expect(block.indexOf("own fact")).toBeLessThan(block.indexOf("Summary of our history"));
  });

  it("carries global facts for a hoot with none of its own", () => {
    const fresh = uuid();
    db.prepare(
      `INSERT INTO hoots (id, name, status, model_base_url, model_name, model_params, system_prompt, created_at)
       VALUES (?, 'New', 'active', 'http://127.0.0.1:1/v1', 'test-model', NULL, '', ?)`
    ).run(fresh, now());

    expect(pellet.pelletContextBlock(fresh)).toBe("Long-term memory:\n- shared fact");
  });
});
