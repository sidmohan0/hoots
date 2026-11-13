import rrulePkg from "rrule";
// rrule ships CJS without an exports map; destructure via default interop.
const { RRule } = rrulePkg as any;
import { db, now, uuid } from "./db.js";
import { startTurn } from "./turns.js";
import { bus } from "./stream.js";

export function computeNextFire(rrule: string, timezone: string, afterMs = Date.now()): number | null {
  try {
    // RFC 5545 line(s) e.g. "DTSTART;TZID=America/Los_Angeles:20261104T060000\nRRULE:..."
    const rule = RRule.fromString(rrule.includes("RRULE:") ? rrule : `RRULE:${rrule}`);
    const next = rule.after(new Date(afterMs), true);
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function createAutomation(input: {
  hoot_id: string; title: string; prompt: string; rrule: string; timezone?: string;
  thread_kind?: string; deliver?: number;
}) {
  const id = uuid();
  const tz = input.timezone ?? "UTC";
  db.prepare(
    `INSERT INTO automations (id, hoot_id, title, prompt, rrule, timezone, enabled, thread_kind, deliver, created_at, next_fire_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(
    id, input.hoot_id, input.title, input.prompt, input.rrule, tz,
    input.thread_kind ?? "bough", input.deliver ?? 1, now(),
    computeNextFire(input.rrule, tz)
  );
  return db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
}

export async function tickScheduler(deliverFn?: (hootId: string, text: string) => Promise<void>) {
  const due = db
    .prepare(`SELECT * FROM automations WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?`)
    .all(now()) as any[];
  for (const a of due) {
    const thread = db
      .prepare(`SELECT id FROM threads WHERE hoot_id = ? AND kind = ?`)
      .get(a.hoot_id, a.thread_kind) as any;
    if (!thread) continue;
    try {
      const turnId = await startTurn({ threadId: thread.id, trigger: "automation", message: a.prompt });
      bus.publish({ event: "automation.fired", data: { automation_id: a.id, turn_id: turnId } });
      if (a.deliver && deliverFn) {
        // v1: deliver the automation prompt acknowledgment flow — the turn's
        // outbound message is delivered by the herald watching for hoot messages.
        void deliverFn;
      }
    } finally {
      db.prepare(`UPDATE automations SET last_fired_at = ?, next_fire_at = ? WHERE id = ?`).run(
        now(), computeNextFire(a.rrule, a.timezone, now() + 1000), a.id
      );
    }
  }
}

export function startScheduler(deliverFn?: (hootId: string, text: string) => Promise<void>) {
  const t = setInterval(() => {
    tickScheduler(deliverFn).catch(() => {});
  }, 60_000);
  // also catch up once at boot (coalesced missed fires)
  setTimeout(() => tickScheduler(deliverFn).catch(() => {}), 3_000);
  return t;
}
