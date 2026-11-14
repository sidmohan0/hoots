import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, now, uuid } from "../src/db.js";

// Model stubbed behind a gate, like turns.test.ts: the test controls when a
// turn lands so the hunt's status transitions are observable mid-flight.
type Seen = { system: string; last: string | null };
const seen: Seen[] = [];
let gate: (() => void) | null = null;

vi.mock("../src/model.js", () => ({
  ToolLoopMaxHopsComputer: 24,
  ToolLoopMaxHops: 8,
  runTurn: async (
    _model: unknown,
    messages: { role: string; content: string }[],
    _tools: unknown,
    _ctx: unknown,
    cb: { onItem: (i: { kind: string; role?: string; content: unknown }) => void }
  ) => {
    seen.push({
      system: String(messages[0]?.content ?? ""),
      last: messages.at(-1)?.content ?? null,
    });
    await new Promise<void>((resolve) => {
      gate = resolve;
    });
    cb.onItem({ kind: "message", role: "hoot", content: { text: "done: ranked the cafés" } });
    return "done";
  },
}));

let turns: typeof import("../src/turns.js");
let tools: typeof import("../src/tools.js");
let topics: typeof import("../src/topics.js");
let scheduler: typeof import("../src/scheduler.js");
let server: typeof import("../src/server.js");

const hootId = uuid();
const boughId = uuid();
const ctx = (over: Partial<{ turnId: string }> = {}) => ({ hootId, threadId: boughId, turnId: over.turnId ?? uuid() });

async function untilStubbed(n = 1) {
  await vi.waitFor(() => {
    if (!gate || seen.length < n) throw new Error("stub not entered yet");
  });
}

async function release(n = 1) {
  await untilStubbed(n);
  const g = gate;
  gate = null;
  g!();
  await new Promise((r) => setTimeout(r, 25));
}

function seedHoot(id = hootId, name = "Juniper") {
  db.prepare(
    `INSERT INTO hoots (id, name, status, model_base_url, model_name, model_params, system_prompt, created_at)
     VALUES (?, ?, 'active', 'http://127.0.0.1:1/v1', 'test-model', NULL, 'you are juniper', ?)`
  ).run(id, name, now());
}

/** Append a message item on the bough, through a throwaway completed turn. */
function say(text: string, role: "user" | "hoot" = "user", thread = boughId) {
  const turnId = uuid();
  db.prepare(
    `INSERT INTO turns (id, thread_id, status, trigger, started_at, completed_at, origin_surface)
     VALUES (?, ?, 'completed', 'user', ?, ?, 'web')`
  ).run(turnId, thread, now(), now());
  db.prepare(
    `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
     VALUES (?, ?, ?, 1, 'message', ?, ?, ?)`
  ).run(uuid(), turnId, thread, role, JSON.stringify({ text }), now());
}

function insertFact(hoot: string, text: string, scope: "global" | "hoot" = "hoot") {
  const id = uuid();
  db.prepare(
    `INSERT INTO facts (id, hoot_id, text, category, scope, source_item_id, confidence, created_at)
     VALUES (?, ?, ?, 'other', ?, NULL, 'confirmed', ?)`
  ).run(id, hoot, text, scope, now());
  return id;
}

beforeAll(async () => {
  turns = await import("../src/turns.js");
  tools = await import("../src/tools.js");
  topics = await import("../src/topics.js");
  scheduler = await import("../src/scheduler.js");
  server = await import("../src/server.js");
});

beforeEach(() => {
  db.exec(
    "DELETE FROM automation_runs; DELETE FROM automations; DELETE FROM queued_turns; DELETE FROM items; DELETE FROM turns; DELETE FROM threads; DELETE FROM facts; DELETE FROM hoots;"
  );
  seen.length = 0;
  gate = null;
  seedHoot();
  db.prepare(
    `INSERT INTO threads (id, hoot_id, kind, title, status, created_at, updated_at)
     VALUES (?, ?, 'bough', NULL, 'open', ?, ?)`
  ).run(boughId, hootId, now(), now());
});

const huntTool = () => {
  const tool = tools.builtInTools().find((t) => t.name === "create_hunt");
  if (!tool) throw new Error("create_hunt tool missing");
  return tool;
};

describe("create_hunt", () => {
  it("creates a hunt thread on the current hoot and starts working it", async () => {
    const goal = "Find three quiet cafés near the office and rank them";
    const turnId = uuid();
    const res = (await huntTool().execute({ goal }, ctx({ turnId }))) as any;

    expect(typeof res.thread_id).toBe("string");
    const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(res.thread_id) as any;
    expect(thread).toMatchObject({ hoot_id: hootId, kind: "hunt", goal, title: goal, status: "open" });

    // The hoot is working it right now, on its own thread.
    await untilStubbed();
    const turn = db.prepare("SELECT * FROM turns WHERE thread_id = ?").get(res.thread_id) as any;
    expect(turn.trigger).toBe("tool");
    expect(turn.status).toBe("in_progress");

    // Context frames it as a hunt, not bough chatter.
    expect(seen[0].system).toContain(`This is a hunt: ${goal}.`);
    expect(seen[0].system).toContain("Work it to completion, then summarise in one short message.");
    // …and the goal is also the turn's user message.
    expect(seen[0].last).toBe(goal);
  });

  it("completes the hunt once the turn lands, and leaves the bough alone", async () => {
    const { thread_id } = (await huntTool().execute({ goal: "Draft the offsite plan" }, ctx())) as any;
    await release();

    expect((db.prepare("SELECT status FROM threads WHERE id = ?").get(thread_id) as any).status).toBe("complete");
    expect((db.prepare("SELECT status FROM threads WHERE id = ?").get(boughId) as any).status).toBe("open");
    // (a bough turn issued from inside the hunt still gets no hunt framing)
  });

  it("does not reopen a completed hunt, or re-complete it", async () => {
    const { thread_id } = (await huntTool().execute({ goal: "Ship the invoice" }, ctx())) as any;
    await release();
    await turns.startTurn({ threadId: thread_id, trigger: "tool", message: "follow-up" });
    await release();

    expect((db.prepare("SELECT COUNT(*) n FROM turns WHERE thread_id = ?").get(thread_id) as any).n).toBe(2);
    expect((db.prepare("SELECT status FROM threads WHERE id = ?").get(thread_id) as any).status).toBe("complete");
  });

  it("truncates a long goal into the title", async () => {
    const goal = "A".repeat(200);
    const { thread_id } = (await huntTool().execute({ goal }, ctx())) as any;
    const thread = db.prepare("SELECT title, goal FROM threads WHERE id = ?").get(thread_id) as any;

    expect(thread.goal).toBe(goal);
    expect(thread.title.length).toBeLessThanOrEqual(80);
    expect(thread.title.endsWith("…")).toBe(true);
    await release();
  });

  it("rejects an empty goal", async () => {
    await expect(huntTool().execute({ goal: "  " }, ctx())).rejects.toThrow(/goal required/);
    expect((db.prepare("SELECT COUNT(*) n FROM threads WHERE kind = 'hunt'").get() as any).n).toBe(0);
  });
});

describe("automations with thread_kind = hunt", () => {
  it("spawns a hunt per fire instead of writing to the bough", async () => {
    db.prepare(
      `INSERT INTO automations (id, hoot_id, title, prompt, rrule, timezone, enabled, thread_kind, deliver, created_at, next_fire_at)
       VALUES (?, ?, 'Weekly review', 'Review the week and note what slipped', 'RRULE:FREQ=WEEKLY', 'UTC', 1, 'hunt', 1, ?, ?)`
    ).run(uuid(), hootId, now(), now() - 1000);

    await scheduler.tickScheduler();
    await untilStubbed();

    const hunts = db.prepare("SELECT * FROM threads WHERE kind = 'hunt'").all() as any[];
    expect(hunts.length).toBe(1);
    expect(hunts[0]).toMatchObject({ hoot_id: hootId, goal: "Review the week and note what slipped", status: "open" });
    expect(seen[0].system).toContain("This is a hunt:");
    // Nothing landed in the bough.
    expect((db.prepare("SELECT COUNT(*) n FROM items WHERE thread_id = ?").get(boughId) as any).n).toBe(0);

    await release();
    expect((db.prepare("SELECT status FROM threads WHERE id = ?").get(hunts[0].id) as any).status).toBe("complete");
  });

  it("still fires bough automations into the bough", async () => {
    db.prepare(
      `INSERT INTO automations (id, hoot_id, title, prompt, rrule, timezone, enabled, thread_kind, deliver, created_at, next_fire_at)
       VALUES (?, ?, 'Morning', 'Good morning', 'RRULE:FREQ=DAILY', 'UTC', 1, 'bough', 1, ?, ?)`
    ).run(uuid(), hootId, now(), now() - 1000);

    await scheduler.tickScheduler();
    await untilStubbed();
    expect((db.prepare("SELECT COUNT(*) n FROM threads WHERE kind = 'hunt'").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM items WHERE thread_id = ?").get(boughId) as any).n).toBe(1);
    await release();
  });
});

describe("topics", () => {
  it("counts recurring keywords, most frequent first", () => {
    say("Owls roost near the canyon; the canyon owls are loud");
    say("Canyon walks at dusk with the owls", "hoot");
    say("a an the owls", "hoot"); // short/stop words dropped

    const got = topics.deriveTopics(hootId);
    expect(got.slice(0, 2)).toEqual([
      { topic: "owls", count: 4 },
      { topic: "canyon", count: 3 },
    ]);
    // ties fall back to alphabetical order
    expect(got.slice(2).map((t) => t.topic)).toEqual(["dusk", "loud", "roost", "walks"]);
  });

  it("drops stopwords and tokens under four characters", () => {
    say("this that with from really owls");
    const got = topics.deriveTopics(hootId).map((t) => t.topic);
    expect(got).toEqual(["owls"]);
  });

  it("counts only message items, not note or tool rows", () => {
    say("pelicans over the bay");
    const turnId = uuid();
    db.prepare(
      `INSERT INTO turns (id, thread_id, status, trigger, started_at, completed_at, origin_surface)
       VALUES (?, ?, 'completed', 'tool', ?, ?, 'web')`
    ).run(turnId, boughId, now(), now());
    db.prepare(
      `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
       VALUES (?, ?, ?, 2, 'note', NULL, ?, ?)`
    ).run(uuid(), turnId, boughId, JSON.stringify({ fact: "herons nest on the pier" }), now());

    expect(topics.deriveTopics(hootId).map((t) => t.topic)).toEqual(["pelicans"]);
  });

  it("narrows by fragment for palette search", () => {
    say("canyon owls and canyon wind");
    expect(topics.deriveTopics(hootId, "can").map((t) => t.topic)).toEqual(["canyon"]);
    expect(topics.deriveTopics(hootId, "zzz")).toEqual([]);
  });

  it("is scoped to one hoot", () => {
    const other = uuid();
    seedHoot(other, "Brian");
    db.prepare(
      `INSERT INTO threads (id, hoot_id, kind, title, status, created_at, updated_at)
       VALUES (?, ?, 'bough', NULL, 'open', ?, ?)`
    ).run(uuid(), other, now(), now());
    say("pelicans over the bay");
    expect(topics.deriveTopics(other)).toEqual([]);
  });
});

describe("fact scope promotion (DECISIONS #13)", () => {
  it("promotes to global, exposes it via GET /v1/facts?scope=global, and feeds other hoots", async () => {
    const factId = insertFact(hootId, "Sid's timezone is America/Los_Angeles");
    const other = uuid();
    seedHoot(other, "Brian");
    const app = server.buildServer();
    const auth = { authorization: "Bearer test-token" };

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/facts/${factId}`,
      headers: auth,
      payload: { scope: "global" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: factId, scope: "global" });

    const globals = await app.inject({ method: "GET", url: "/v1/facts?scope=global", headers: auth });
    expect(globals.statusCode).toBe(200);
    expect(globals.json().map((f: any) => f.text)).toContain("Sid's timezone is America/Los_Angeles");

    // Another hoot's context carries it; hoot-scoped facts stay home.
    insertFact(hootId, "private hoot fact");
    const { pelletContextBlock } = await import("../src/pellet.js");
    expect(pelletContextBlock(other)).toContain("timezone");
    expect(pelletContextBlock(other)).not.toContain("private hoot fact");

    // …and back again.
    const back = await app.inject({
      method: "PATCH",
      url: `/v1/facts/${factId}`,
      headers: auth,
      payload: { scope: "hoot" },
    });
    expect(back.json()).toMatchObject({ scope: "hoot" });
    expect(
      (await app.inject({ method: "GET", url: "/v1/facts?scope=global", headers: auth })).json().map((f: any) => f.id)
    ).not.toContain(factId);

    await app.close();
  });

  it("keeps text/confidence patches working and rejects unknown scopes", async () => {
    const factId = insertFact(hootId, "old text");
    const app = server.buildServer();
    const auth = { authorization: "Bearer test-token" };

    const edited = await app.inject({
      method: "PATCH",
      url: `/v1/facts/${factId}`,
      headers: auth,
      payload: { text: "new text", confidence: "pinned" },
    });
    expect(edited.json()).toMatchObject({ text: "new text", confidence: "pinned", scope: "hoot" });

    const bad = await app.inject({
      method: "PATCH",
      url: `/v1/facts/${factId}`,
      headers: auth,
      payload: { scope: "everywhere" },
    });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });
});

describe("topic routes", () => {
  it("serves counts per hoot and via the flat palette alias", async () => {
    say("canyon owls and canyon wind");
    const app = server.buildServer();
    const auth = { authorization: "Bearer test-token" };

    const perHoot = await app.inject({ method: "GET", url: `/v1/hoots/${hootId}/topics`, headers: auth });
    expect(perHoot.statusCode).toBe(200);
    expect(perHoot.json()).toEqual([
      { topic: "canyon", count: 2 },
      { topic: "owls", count: 1 },
      { topic: "wind", count: 1 },
    ]);

    const flat = await app.inject({ method: "GET", url: `/v1/topics?hoot=${hootId}&q=owl`, headers: auth });
    expect(flat.json()).toEqual([{ topic: "owls", count: 1 }]);

    expect((await app.inject({ method: "GET", url: "/v1/topics", headers: auth })).statusCode).toBe(400);
    await app.close();
  });
});
