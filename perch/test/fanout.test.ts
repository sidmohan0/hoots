import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db, now, uuid } from "../src/db.js";
import { registerHerald, startHeralds, stopHeralds, resetHeralds, fanOut } from "../src/herald.js";
import type { Herald } from "../src/herald.js";

const hootId = uuid();
const threadId = uuid();

const sent: { surface: string; text: string }[] = [];

function fakeHerald(surface: string, destinations = 1): Herald {
  return {
    id: `herald-${surface}`,
    start(ctx) {
      ctx.transport(async (text) => {
        sent.push({ surface, text });
        return destinations;
      });
      return () => {};
    },
  };
}

function seed(originSurface: string) {
  db.exec(
    `DELETE FROM items; DELETE FROM turns; DELETE FROM queued_turns; DELETE FROM threads;
     DELETE FROM read_state; DELETE FROM facts; DELETE FROM day_digests;
     DELETE FROM automation_runs; DELETE FROM automations; DELETE FROM hoots;`
  );
  db.prepare(
    `INSERT INTO hoots (id, name, status, model_base_url, model_name, model_params, system_prompt, created_at)
     VALUES (?, 'Juniper', 'active', 'http://127.0.0.1:1/v1', 'test-model', NULL, '', ?)`
  ).run(hootId, now());
  db.prepare(
    `INSERT INTO threads (id, hoot_id, kind, status, created_at, updated_at) VALUES (?, ?, 'bough', 'open', ?, ?)`
  ).run(threadId, hootId, now(), now());
  const turnId = uuid();
  db.prepare(
    `INSERT INTO turns (id, thread_id, status, trigger, started_at, origin_surface) VALUES (?, ?, 'completed', 'channel', ?, ?)`
  ).run(turnId, threadId, now(), originSurface);
  const itemId = uuid();
  db.prepare(
    `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
     VALUES (?, ?, ?, 1, 'message', 'hoot', ?, ?)`
  ).run(itemId, turnId, threadId, JSON.stringify({ text: "hello out there" }), now());
  return { turnId, itemId };
}

const item = (turnId: string, itemId: string) => ({
  id: itemId, turn_id: turnId, thread_id: threadId, seq: 1, kind: "message", role: "hoot",
  content: JSON.stringify({ text: "hello out there" }),
});

beforeEach(() => {
  resetHeralds();
  sent.length = 0;
  registerHerald(fakeHerald("telegram"));
  registerHerald(fakeHerald("imessage"));
  startHeralds();
});

afterEach(() => {
  stopHeralds();
});

describe("herald fan-out routing", () => {
  it("answers on the surface the turn came from", async () => {
    const { turnId, itemId } = seed("telegram");
    const surfaces = await fanOut(item(turnId, itemId));
    expect(surfaces).toEqual(["telegram"]);
    expect(sent.map((s) => s.surface)).toEqual(["telegram"]);
  });

  it("routes an iMessage turn to iMessage only", async () => {
    const { turnId, itemId } = seed("imessage");
    await fanOut(item(turnId, itemId));
    expect(sent.map((s) => s.surface)).toEqual(["imessage"]);
  });

  it("broadcasts automation turns (origin system) to every herald", async () => {
    const { turnId, itemId } = seed("system");
    const surfaces = await fanOut(item(turnId, itemId));
    expect(surfaces.sort()).toEqual(["imessage", "telegram"]);
  });

  it("keeps web and silent turns off the heralds", async () => {
    for (const origin of ["web", "silent"]) {
      const { turnId, itemId } = seed(origin);
      expect(await fanOut(item(turnId, itemId))).toEqual([]);
    }
    expect(sent).toEqual([]);
  });

  it("stays quiet while a web tab was read in the last minute", async () => {
    const { turnId, itemId } = seed("telegram");
    db.prepare(`INSERT INTO read_state (hoot_id, surface, last_read_at) VALUES (?, 'web', ?)`).run(hootId, now());
    expect(await fanOut(item(turnId, itemId))).toEqual([]);
  });

  it("stamps the delivery and ignores user-role items", async () => {
    const { turnId, itemId } = seed("telegram");
    await fanOut(item(turnId, itemId));
    const row = db.prepare(`SELECT delivered FROM items WHERE id = ?`).get(itemId) as any;
    expect(row.delivered).toBe("telegram");

    await fanOut({ ...item(turnId, itemId), role: "user" });
    expect(sent).toHaveLength(1);
  });

  it("does not stamp when the herald addressed no destination", async () => {
    resetHeralds();
    registerHerald(fakeHerald("telegram", 0));
    startHeralds();
    const { turnId, itemId } = seed("telegram");
    await fanOut(item(turnId, itemId));
    expect((db.prepare(`SELECT delivered FROM items WHERE id = ?`).get(itemId) as any).delivered).toBe("");
  });
});
