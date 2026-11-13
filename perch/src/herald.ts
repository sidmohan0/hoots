// Heralds: channel bridges. A herald carries messages between one outside
// surface and the perch. The contract is deliberately small — a herald owns
// only translation to/from its own wire format, and starts a transport:
//
//   start(ctx)  -> installs an outbound transport, opens the inbound loop,
//                  returns a stop function.
//   ctx.send    -> perch -> surface ("fan this hoot message out").
//   ctx.deliver -> surface -> perch (inbound text becomes a channel turn).
//
// Everything ledger-shaped (chat bindings, read state, turns, delivery stamps)
// stays on this side of the contract, so a new herald never re-implements it.
import { db, now } from "./db.js";
import { startTurn } from "./turns.js";
import { bus } from "./stream.js";

export interface HeraldContext {
  /** Outbound: push `text` for hoot `hootId` out through this herald.
   *  Resolves with the number of destinations actually addressed. */
  send(text: string, hootId: string): Promise<number>;
  /** Inbound: surface text -> `trigger: "channel"` turn in the hoot's bough. */
  deliver(hootId: string, chatKey: string, surface: string, text: string): Promise<unknown>;
  /** Called from `start` to install the herald's outbound transport. */
  transport(fn: (text: string, hootId: string) => Promise<number>): void;
}

export interface Herald {
  /** Stable id; the surface is the id minus the `herald-` prefix. */
  id: string;
  start(ctx: HeraldContext): () => void;
}

export const surfaceOf = (id: string) => id.replace(/^herald-/, "");

let registered = new Map<string, Herald>();

type ActiveHerald = {
  id: string;
  surface: string;
  send: (text: string, hootId: string) => Promise<number>;
  stop: () => void;
};

let active = new Map<string, ActiveHerald>();
let listener: ((ev: any) => void) | null = null;

export function registerHerald(h: Herald): void {
  registered.set(h.id, h);
}

export function activeHeralds(): ActiveHerald[] {
  return [...active.values()];
}

/** Bind an external id (chat id, handle) of `surface` to a hoot. */
export function bindSurface(hootId: string, surface: string, externalId: string): void {
  db.prepare(
    `INSERT INTO channels (id, hoot_id, kind, external_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, external_id) DO UPDATE SET hoot_id = excluded.hoot_id`
  ).run(crypto.randomUUID(), hootId, surface, String(externalId), now());
}

export function channelFor(surface: string, externalId: string) {
  return db
    .prepare(`SELECT * FROM channels WHERE kind = ? AND external_id = ?`)
    .get(surface, String(externalId)) as any;
}

// --- inbound ---------------------------------------------------------------

export async function deliver(hootId: string, _chatKey: string, surface: string, text: string) {
  const bough = db
    .prepare(`SELECT id FROM threads WHERE hoot_id = ? AND kind = 'bough'`)
    .get(hootId) as any;
  if (!bough) return { ok: false, reason: "no bough" };
  // Record inbound activity for the per-surface "last heard from you" line.
  db.prepare(
    `INSERT INTO read_state (hoot_id, surface, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(hoot_id, surface) DO UPDATE SET last_read_at = excluded.last_read_at`
  ).run(hootId, surface, now());
  return startTurn({ threadId: bough.id, trigger: "channel", message: text, surface: surface as any });
}

// --- outbound fan-out ------------------------------------------------------

const WEB_FOCUS_MS = 60_000;

function stampDelivered(itemId: string, surface: string) {
  db.prepare(
    `UPDATE items SET delivered = CASE WHEN delivered = '' THEN ? ELSE delivered || ',' || ? END WHERE id = ?`
  ).run(surface, surface, itemId);
}

function itemText(content: unknown): string | null {
  const parsed = typeof content === "string" ? (() => { try { return JSON.parse(content); } catch { return {}; } })() : content;
  const text = (parsed as any)?.text;
  return typeof text === "string" && text ? text : null;
}

/**
 * Route one appended item to the heralds that should receive it.
 * Returns the surfaces addressed. Policy (DECISIONS.md, board 07):
 * reply-where-spoken — an inbound turn answers only on its own surface;
 * automation fires (`system`) reach every binding; while a web tab has been
 * read in the last minute nothing buzzes a phone.
 */
export async function fanOut(item: any): Promise<string[]> {
  if (item?.kind !== "message" || item.role !== "hoot") return [];
  const thread = db.prepare(`SELECT hoot_id FROM threads WHERE id = ?`).get(item.thread_id) as any;
  if (!thread) return [];
  const turn = db.prepare(`SELECT origin_surface FROM turns WHERE id = ?`).get(item.turn_id) as any;
  const origin: string = turn?.origin_surface ?? "web";

  const targets = activeHeralds().filter((h) => origin === "system" || h.surface === origin);
  if (!targets.length) return [];

  const text = itemText(item.content);
  if (!text) return [];

  const rs = db
    .prepare(`SELECT last_read_at FROM read_state WHERE hoot_id = ? AND surface = 'web'`)
    .get(thread.hoot_id) as any;
  if (rs?.last_read_at && Date.now() - rs.last_read_at < WEB_FOCUS_MS) return [];

  const sent: string[] = [];
  for (const h of targets) {
    const reached = await h.send(text, thread.hoot_id).catch(() => 0);
    if (reached > 0) stampDelivered(item.id, h.surface);
    sent.push(h.surface);
  }
  return sent;
}

// --- lifecycle -------------------------------------------------------------

/** Start every registered herald and arm the fan-out listener. */
export function startHeralds(): void {
  if (!listener) {
    listener = (ev: any) => {
      if (ev?.event === "item.append") void fanOut(ev.data.item);
    };
    bus.on("event", listener);
  }
  for (const h of registered.values()) {
    if (active.has(h.id)) continue;
    let transport: ((text: string, hootId: string) => Promise<number>) | null = null;
    const ctx: HeraldContext = {
      transport: (fn) => { transport = fn; },
      send: async (text, hootId) => (transport ? transport(text, hootId) : 0),
      deliver,
    };
    const stop = h.start(ctx);
    active.set(h.id, { id: h.id, surface: surfaceOf(h.id), send: ctx.send, stop });
  }
}

export function stopHeralds(): void {
  for (const h of active.values()) {
    try { h.stop(); } catch { /* herald already down */ }
  }
  active = new Map();
  if (listener) {
    bus.off("event", listener);
    listener = null;
  }
}

/** Test seam: forget registrations and tear down any running heralds. */
export function resetHeralds(): void {
  stopHeralds();
  registered = new Map();
}
