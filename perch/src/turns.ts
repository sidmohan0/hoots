import { db, now, uuid, localDate } from "./db.js";
import { runTurn, type ModelConfig, type TurnContext } from "./model.js";
import { builtInTools } from "./tools.js";
import { bus } from "./stream.js";
import { pelletContextBlock, regeneratePellet } from "./pellet.js";
import { notifyWebhook } from "./outbound.js";

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

// A write that lands on an already-digested past day must not leave a stale
// digest behind (DECISIONS.md #9: digests describe, they don't forecast).
export function invalidateDigestIfPast(hootId: string, createdAt: number) {
  const date = localDate(createdAt);
  if (date >= localDate()) return;
  db.prepare(`DELETE FROM day_digests WHERE hoot_id = ? AND date = ?`).run(hootId, date);
}

// --- context assembly ------------------------------------------------------

const MISS_NOTE =
  "You were late because the machine was asleep; open with one short apology, then continue.";

function buildMessages(hoot: any, thread: any, userText: string | null, missNote = false) {
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
  if (missNote) systemParts.push(MISS_NOTE);
  messages.push({ role: "system", content: systemParts.join("\n\n") });
  for (const h of history) {
    const c = JSON.parse(h.content);
    messages.push({ role: h.role === "hoot" ? "assistant" : "user", content: c.text ?? "" });
  }
  if (userText != null) messages.push({ role: "user", content: userText });
  return messages;
}

// --- presence ---------------------------------------------------------------

// In-memory claim mirror (threadId -> turn). Presence reads this so a turn is
// "thinking" the instant it is claimed; the DB claim in `turns` stays the
// durable source and is reconciled on boot.
const busy = new Map<string, { turnId: string; startedAt: number }>();

export function busyState(): { threadId: string; turnId: string; startedAt: number }[] {
  return [...busy].map(([threadId, v]) => ({ threadId, ...v }));
}

// --- turn execution ---------------------------------------------------------

// DB-level claim: turns are serial per thread, and the claim lives in the turns
// table itself (status = 'in_progress') so it survives restarts and is shared
// by every caller (API, herald, scheduler). better-sqlite3 transactions are
// synchronous, so check-and-insert is atomic; BEGIN IMMEDIATE takes the write
// lock up front to avoid deferred-transaction upgrade races.
const claimTurn = db.transaction((threadId: string, turnId: string, trigger: string, startedAt: number, surface: string) => {
  const busy = db
    .prepare(`SELECT id FROM turns WHERE thread_id = ? AND status = 'in_progress' LIMIT 1`)
    .get(threadId);
  if (busy) throw new Error("thread is busy with another turn");
  db.prepare(
    `INSERT INTO turns (id, thread_id, status, trigger, started_at, origin_surface) VALUES (?, ?, 'in_progress', ?, ?, ?)`
  ).run(turnId, threadId, trigger, startedAt, surface);
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
  if (busy.get(threadId)?.turnId === turnId || !busy.has(threadId)) busy.delete(threadId);
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
  // 'silent' = automation turns with deliver=0: recorded, never pushed to a herald.
  surface?: "web" | "telegram" | "imessage" | "system" | "silent";
  missNote?: boolean;
}): Promise<{ turnId: string; queued: boolean; queueId?: string }> {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(opts.threadId) as any;
  if (!thread) throw new Error(`thread ${opts.threadId} not found`);

  const hoot = db.prepare("SELECT * FROM hoots WHERE id = ?").get(thread.hoot_id) as any;
  if (!hoot || hoot.status !== "active") throw new Error("hoot is not active");

  const turnId = uuid();
  try {
    const startedAt = now();
    claimTurn.immediate(thread.id, turnId, opts.trigger, startedAt, opts.surface ?? "web");
    busy.set(thread.id, { turnId, startedAt });
  } catch {
    // Composer never blocks (DECISIONS.md #6): queue it; it starts when the
    // in-flight turn lands.
    const queueId = uuid();
    db.prepare(`INSERT INTO queued_turns (id, thread_id, message, surface, miss_note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(queueId, thread.id, opts.message ?? "", opts.surface ?? "web", opts.missNote ? 1 : 0, now());
    return { turnId: "", queued: true, queueId };
  }

  const surface = opts.surface ?? "web";
  if (opts.message) {
    const createdAt = now();
    db.prepare(
      `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, surface, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM items WHERE thread_id = ?), 'message', 'user', ?, ?, ?)`
    ).run(uuid(), turnId, thread.id, thread.id, JSON.stringify({ text: opts.message }), surface, createdAt);
    invalidateDigestIfPast(hoot.id, createdAt);
  }

  bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "in_progress" } });

  // execute async; API returns turn id immediately
  executeTurn(turnId, hoot, thread, opts.missNote ?? false).finally(() => drainQueue(thread.id)).catch((err) => {
    const msg = String(err?.message ?? err);
    releaseTurn(thread.id, turnId, "interrupted", msg);
    bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "interrupted", error: msg } });
  });

  return { turnId, queued: false };
}

/** Start the next queued turn for a thread, if any (DECISIONS.md #6). */
async function drainQueue(threadId: string) {
  const next = db
    .prepare(`SELECT * FROM queued_turns WHERE thread_id = ? ORDER BY created_at LIMIT 1`)
    .get(threadId) as any;
  if (!next) return;
  db.prepare(`DELETE FROM queued_turns WHERE id = ?`).run(next.id);
  try {
    await startTurn({
      threadId, trigger: "user", message: next.message, surface: next.surface as any, missNote: !!next.miss_note,
    });
  } catch {
    // re-queue if the thread is somehow busy again
    db.prepare(`INSERT INTO queued_turns (id, thread_id, message, surface, miss_note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuid(), threadId, next.message, next.surface, next.miss_note ?? 0, now());
  }
}

/** Boot: queued turns survive restarts; drain them after reconciliation. */
export async function drainAllQueues() {
  const rows = db.prepare(`SELECT DISTINCT thread_id FROM queued_turns`).all() as any[];
  for (const r of rows) await drainQueue(r.thread_id);
}

async function executeTurn(turnId: string, hoot: any, thread: any, missNote = false) {
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
  const messages = buildMessages(hoot, thread, lastUser ? JSON.parse(lastUser.content).text : null, missNote);

  await runTurn(model, messages, builtInTools(), ctx, {
    onItem: (item) => {
      seq += 1;
      const id = uuid();
      const createdAt = now();
      db.prepare(
        `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, turnId, thread.id, seq, item.kind, item.role ?? null, JSON.stringify(item.content), createdAt);
      invalidateDigestIfPast(hoot.id, createdAt);
      bus.publish({ event: "item.append", data: { item: { id, turn_id: turnId, thread_id: thread.id, seq, ...item } } });
    },
  });

  releaseTurn(thread.id, turnId, "completed");
  db.prepare(`UPDATE threads SET updated_at=? WHERE id=?`).run(now(), thread.id);
  bus.publish({ event: "turn.status", data: { turn_id: turnId, status: "completed" } });

  // Best-effort webhook; nothing about the turn waits on it.
  notifyWebhook(
    { event: "turn.completed", hoot_id: hoot.id, thread_id: thread.id, turn_id: turnId, ts: now() },
    "turn.completed"
  );

  // pellet upkeep: regenerate on growth threshold (async, failure-tolerant)
  if (boughItemCount(hoot.id) % PELLET_EVERY_N_ITEMS === 0) {
    regeneratePellet(hoot.id).catch(() => {});
  }
}
