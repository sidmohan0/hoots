import { db, now, uuid } from "./db.js";
import { runTurn, type ModelConfig, type TurnContext } from "./model.js";
import { builtInTools } from "./tools.js";
import { bus } from "./stream.js";

const PELLET_EVERY_N_ITEMS = 50;
const CONTEXT_WINDOW_ITEMS = 40;

// --- pellet ---------------------------------------------------------------
// v1: pellet = pinned notes + last summary, regenerated as a plain digest.
// Summarization-via-model upgrade lands with the scheduler hardening pass.

function boughItemCount(hootId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items i JOIN threads t ON t.id = i.thread_id
       WHERE t.hoot_id = ? AND t.kind = 'bough'`
    )
    .get(hootId) as any;
  return row.n;
}

export function pelletKey(hootId: string) {
  return `pellet:${hootId}`;
}

export function getPellet(hootId: string): { facts: string[]; generated_at: number | null } {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(pelletKey(hootId)) as any;
  if (!row) return { facts: [], generated_at: null };
  return JSON.parse(row.value);
}

export function regeneratePellet(hootId: string) {
  const facts = db
    .prepare(
      `SELECT i.content FROM items i JOIN threads t ON t.id = i.thread_id
       WHERE t.hoot_id = ? AND i.kind = 'note' ORDER BY i.created_at DESC LIMIT 200`
    )
    .all(hootId)
    .map((r: any) => JSON.parse(r.content).fact);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(pelletKey(hootId), JSON.stringify({ facts, generated_at: now() }));
  return getPellet(hootId);
}

// --- context assembly ------------------------------------------------------

function buildMessages(hoot: any, thread: any, userText: string | null) {
  const pellet = getPellet(hoot.id);
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
  if (pellet.facts.length) {
    systemParts.push(`Long-term memory (pinned facts):\n${pellet.facts.map((f) => `- ${f}`).join("\n")}`);
  }
  messages.push({ role: "system", content: systemParts.join("\n\n") });
  for (const h of history) {
    const c = JSON.parse(h.content);
    messages.push({ role: h.role === "hoot" ? "assistant" : "user", content: c.text ?? "" });
  }
  if (userText != null) messages.push({ role: "user", content: userText });
  return messages;
}

// --- turn execution ---------------------------------------------------------

const turnLocks = new Set<string>();

export async function startTurn(opts: {
  threadId: string;
  trigger: "user" | "automation" | "channel" | "tool";
  message?: string | null;
}): Promise<string> {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(opts.threadId) as any;
  if (!thread) throw new Error(`thread ${opts.threadId} not found`);
  if (turnLocks.has(thread.id)) throw new Error("thread is busy with another turn");

  const hoot = db.prepare("SELECT * FROM hoots WHERE id = ?").get(thread.hoot_id) as any;
  if (!hoot || hoot.status !== "active") throw new Error("hoot is not active");

  const turnId = uuid();
  db.prepare(
    `INSERT INTO turns (id, thread_id, status, trigger, started_at) VALUES (?, ?, 'in_progress', ?, ?)`
  ).run(turnId, thread.id, opts.trigger, now());

  if (opts.message) {
    db.prepare(
      `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM items WHERE thread_id = ?), 'message', 'user', ?, ?)`
    ).run(uuid(), turnId, thread.id, thread.id, JSON.stringify({ text: opts.message }), now());
  }

  bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "in_progress" } });

  // execute async; API returns turn id immediately
  executeTurn(turnId, hoot, thread).catch((err) => {
    db.prepare(`UPDATE turns SET status='interrupted', error=?, completed_at=? WHERE id=?`).run(
      String(err?.message ?? err), now(), turnId
    );
    bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "interrupted", error: String(err?.message ?? err) } });
  });

  return turnId;
}

async function executeTurn(turnId: string, hoot: any, thread: any) {
  const lockKey = thread.id;
  turnLocks.add(lockKey);
  try {
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

    db.prepare(`UPDATE turns SET status='completed', completed_at=? WHERE id=?`).run(now(), turnId);
    db.prepare(`UPDATE threads SET updated_at=? WHERE id=?`).run(now(), thread.id);
    bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "completed" } });

    // pellet upkeep: regenerate on growth threshold
    if (boughItemCount(hoot.id) % PELLET_EVERY_N_ITEMS === 0) regeneratePellet(hoot.id);
  } finally {
    turnLocks.delete(lockKey);
  }
}
