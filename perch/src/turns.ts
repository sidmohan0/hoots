import { db, now, uuid } from "./db.js";
import { runTurn, type ModelConfig, type TurnContext } from "./model.js";
import { builtInTools } from "./tools.js";
import { bus } from "./stream.js";
import { pelletContextBlock, regeneratePellet } from "./pellet.js";

const PELLET_EVERY_N_ITEMS = 50;
const CONTEXT_WINDOW_ITEMS = 40;

function boughItemCount(hootId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items i JOIN threads t ON t.id = i.thread_id
       WHERE t.hoot_id = ? AND t.kind = 'bough'`
    )
    .get(hootId) as any;
  return row.n;
}

// --- context assembly ------------------------------------------------------

function buildMessages(hoot: any, thread: any, userText: string | null) {
  const history = db
    .prepare(
      `SELECT kind, role, content FROM items WHERE thread_id = ?
       ORDER BY created_at DESC, seq DESC LIMIT ?`
    )
    .all(thread.id, CONTEXT_WINDOW_ITEMS)
    .reverse()
    .filter((i: any) => i.kind === "message") as any[];

  const messages: any[] = [];
  const systemParts = [hoot.system_prompt];
  const memory = pelletContextBlock(hoot.id);
  if (memory) systemParts.push(memory);
  messages.push({ role: "system", content: systemParts.join("\n\n") });
  for (const h of history) {
    const c = JSON.parse(h.content);
    messages.push({ role: h.role === "hoot" ? "assistant" : "user", content: c.text ?? "" });
  }
  if (userText != null) messages.push({ role: "user", content: userText });
  return messages;
}

// --- turn execution ---------------------------------------------------------

// DB-level claim: turns are serial per thread, and the claim lives in the turns
// table itself (status = 'in_progress') so it survives restarts and is shared
// by every caller (API, herald, scheduler). better-sqlite3 transactions are
// synchronous, so check-and-insert is atomic; BEGIN IMMEDIATE takes the write
// lock up front to avoid deferred-transaction upgrade races.
const claimTurn = db.transaction((threadId: string, turnId: string, trigger: string, startedAt: number) => {
  const busy = db
    .prepare(`SELECT id FROM turns WHERE thread_id = ? AND status = 'in_progress' LIMIT 1`)
    .get(threadId);
  if (busy) throw new Error("thread is busy with another turn");
  db.prepare(
    `INSERT INTO turns (id, thread_id, status, trigger, started_at) VALUES (?, ?, 'in_progress', ?, ?)`
  ).run(turnId, threadId, trigger, startedAt);
});

/** Close out a turn (the DB analogue of releasing the old in-memory lock). */
export function releaseTurn(
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted",
  error: string | null = null
) {
  db.prepare(
    `UPDATE turns SET status = ?, error = ?, completed_at = ? WHERE id = ? AND thread_id = ? AND status = 'in_progress'`
  ).run(status, error, now(), turnId, threadId);
}

/** On boot: any turn left in_progress by a crash/restart becomes interrupted. */
export function reconcileTurns(): number {
  const stuck = db.prepare(`SELECT id, thread_id FROM turns WHERE status = 'in_progress'`).all() as any[];
  for (const t of stuck) {
    releaseTurn(t.thread_id, t.id, "interrupted", "perch restarted mid-turn");
    bus.publish({ event: "turn.status", data: { turn_id: t.id, status: "interrupted", error: "perch restarted mid-turn" } });
  }
  return stuck.length;
}

export async function startTurn(opts: {
  threadId: string;
  trigger: "user" | "automation" | "channel" | "tool";
  message?: string | null;
}): Promise<string> {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(opts.threadId) as any;
  if (!thread) throw new Error(`thread ${opts.threadId} not found`);

  const hoot = db.prepare("SELECT * FROM hoots WHERE id = ?").get(thread.hoot_id) as any;
  if (!hoot || hoot.status !== "active") throw new Error("hoot is not active");

  const turnId = uuid();
  claimTurn.immediate(thread.id, turnId, opts.trigger, now());

  if (opts.message) {
    db.prepare(
      `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM items WHERE thread_id = ?), 'message', 'user', ?, ?)`
    ).run(uuid(), turnId, thread.id, thread.id, JSON.stringify({ text: opts.message }), now());
  }

  bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "in_progress" } });

  // execute async; API returns turn id immediately
  executeTurn(turnId, hoot, thread).catch((err) => {
    const msg = String(err?.message ?? err);
    releaseTurn(thread.id, turnId, "interrupted", msg);
    bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "interrupted", error: msg } });
  });

  return turnId;
}

async function executeTurn(turnId: string, hoot: any, thread: any) {
  let seq = (db.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM items WHERE turn_id = ?`).get(turnId) as any).m;

  const model: ModelConfig = {
    baseUrl: hoot.model_base_url,
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: hoot.model_name,
    params: hoot.model_params ? JSON.parse(hoot.model_params) : null,
  };
  const ctx: TurnContext = { hootId: hoot.id, threadId: thread.id, turnId };
  const lastUser = db
    .prepare(`SELECT content FROM items WHERE turn_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`)
    .get(turnId) as any;
  const messages = buildMessages(hoot, thread, lastUser ? JSON.parse(lastUser.content).text : null);

  await runTurn(model, messages, builtInTools(), ctx, {
    onItem: (item) => {
      seq += 1;
      const id = uuid();
      db.prepare(
        `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, turnId, thread.id, seq, item.kind, item.role ?? null, JSON.stringify(item.content), now());
      bus.publish({ event: "item.append", data: { item: { id, turn_id: turnId, thread_id: thread.id, seq, ...item } } });
    },
  });

  releaseTurn(thread.id, turnId, "completed");
  db.prepare(`UPDATE threads SET updated_at=? WHERE id=?`).run(now(), thread.id);
  bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "completed" } });

  // pellet upkeep: regenerate on growth threshold (async, failure-tolerant)
  if (boughItemCount(hoot.id) % PELLET_EVERY_N_ITEMS === 0) {
    regeneratePellet(hoot.id).catch(() => {});
  }
}
