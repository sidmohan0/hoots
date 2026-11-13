import rrulePkg from "rrule";
// rrule ships CJS without an exports map; destructure via default interop.
const { RRule } = rrulePkg as any;
import { db, now, uuid, LATE_GRACE_MS, recordAutomationRun, claimMissNote, getMeta, setMeta, localDate } from "./db.js";
import { createHunt, startTurn } from "./turns.js";
import { bus } from "./stream.js";
import { notifyWebhook } from "./outbound.js";
import { config } from "./config.js";

// --- timezone math ---------------------------------------------------------
// rrule's tzid support generates candidates as UTC-naive dates whose fields are
// the *wall clock* in the zone, but compares them against real-epoch after()
// boundaries — which misfires across offsets. So we do the wall<->epoch
// conversion ourselves with Intl and keep the automation's timezone field
// authoritative.

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtfFor(tz: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfCache.set(tz, dtf);
  }
  return dtf;
}

function wallParts(tz: string, epochMs: number) {
  const parts = dtfFor(tz).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(tz: string, epochMs: number): number {
  const { y, mo, d, h, mi, s } = wallParts(tz, epochMs);
  return Date.UTC(y, mo - 1, d, h, mi, s) - epochMs;
}

/** Real epoch ms of a wall-clock moment (UTC-naive Date) in `tz`. */
function wallToEpoch(tz: string, wall: Date): number {
  const u = Date.UTC(
    wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(),
    wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()
  );
  // two passes converge across DST transitions
  let ts = u - tzOffsetMs(tz, u);
  ts = u - tzOffsetMs(tz, ts);
  return ts;
}

/** The instant `epochMs` rendered in `tz`, as a UTC-naive wall-clock Date. */
function epochToWallNaive(tz: string, epochMs: number): Date {
  const { y, mo, d, h, mi, s } = wallParts(tz, epochMs);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

/** DTSTART value (UTC-naive wall clock) from an RFC 5545 text, if present. */
function parseDtstart(text: string): Date | null {
  const line = text.split(/\r?\n/).find((l) => /^DTSTART/i.test(l));
  if (!line) return null;
  const m = /^DTSTART(?:;[^:]*)?:(\d{8}(?:T\d{6})?Z?)$/i.exec(line.trim());
  if (!m) return null;
  const v = m[1].toUpperCase();
  const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
  const h = v.length >= 15 ? +v.slice(9, 11) : 0;
  const mi = v.length >= 15 ? +v.slice(11, 13) : 0;
  const s = v.length >= 15 ? +v.slice(13, 15) : 0;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

export function computeNextFire(rrule: string, timezone: string, afterMs = Date.now()): number | null {
  try {
    // RFC 5545 text, e.g. "DTSTART;TZID=America/Los_Angeles:20261104T060000\nRRULE:..."
    const text = rrule.includes("RRULE:") ? rrule : `RRULE:${rrule}`;
    // rrule parses the options (freq/byhour/...) fine; we only borrow them.
    const parsed = RRule.fromString(text);
    const opts: any = { ...parsed.origOptions };
    // UNTIL given as UTC (trailing Z) must be re-expressed as wall time in tz.
    if (opts.until instanceof Date && /UNTIL[^;\n]*Z/i.test(text)) {
      opts.until = epochToWallNaive(timezone, opts.until.getTime());
    }
    // DTSTART (or, absent, `afterMs`) is a wall-clock anchor in `timezone`;
    // the timezone field wins over any TZID in the string.
    const dtstart = parseDtstart(text) ?? epochToWallNaive(timezone, afterMs);
    const rule = new RRule({ ...opts, dtstart, tzid: timezone });
    // Compare candidates against the after-date rendered in the same zone.
    const nextWall = rule.after(epochToWallNaive(timezone, afterMs), false);
    return nextWall ? wallToEpoch(timezone, nextWall) : null;
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
    // thread_kind decides where the fire lands: the bough, or a fresh hunt
    // spawned for this fire (a hunt is a bounded task, so each fire gets its own).
    const thread =
      a.thread_kind === "hunt"
        ? ({ id: createHunt(a.hoot_id, a.prompt) } as any)
        : (db
            .prepare(`SELECT id FROM threads WHERE hoot_id = ? AND kind = ?`)
            .get(a.hoot_id, a.thread_kind) as any);
    const scheduledAt: number = a.next_fire_at;
    const firedAt = now();
    if (!thread) {
      recordAutomationRun({
        automationId: a.id, hootId: a.hoot_id, scheduledAt, firedAt, outcome: "missed",
      });
      continue;
    }
    const late = firedAt - scheduledAt > LATE_GRACE_MS;
    // Boot catch-ups still fire — they are late, never missed — but only one
    // apology note per hoot per day is allowed to reach the conversation (#10).
    const missNote = late && claimMissNote(a.hoot_id, firedAt);
    try {
      // deliver=1 -> 'system' (heralds push it); deliver=0 -> 'silent' (no push).
      const turnId = await startTurn({
        threadId: thread.id,
        trigger: "automation",
        message: a.prompt,
        missNote,
        surface: a.deliver ? "system" : "silent",
      });
      // The run log is written only once the fire actually happened (#10).
      recordAutomationRun({
        automationId: a.id,
        hootId: a.hoot_id,
        scheduledAt,
        firedAt,
        outcome: late ? "late" : "sent",
      });
      bus.publish({ event: "automation.fired", data: { automation_id: a.id, turn_id: turnId } });
      notifyWebhook(
        { event: "automation.fired", automation_id: a.id, hoot_id: a.hoot_id, turn_id: turnId, outcome: late ? "late" : "sent", ts: firedAt },
        "automation.fired"
      );
      if (a.deliver && deliverFn) {
        // v1: deliver the automation prompt acknowledgment flow — the turn's
        // outbound message is delivered by the herald watching for hoot messages.
        void deliverFn;
      }
    } catch {
      recordAutomationRun({ automationId: a.id, hootId: a.hoot_id, scheduledAt, firedAt: null, outcome: "skipped" });
    } finally {
      db.prepare(`UPDATE automations SET last_fired_at = ?, next_fire_at = ? WHERE id = ?`).run(
        now(), computeNextFire(a.rrule, a.timezone, now() + 1000), a.id
      );
    }
  }
}


// --- night flight ----------------------------------------------------------
// Autonomous pass at 03:00 local over every active hoot's bough (SPEC §6,
// DECISIONS.md #10): one short turn each, silent unless a promise says to
// deliver. Guarded per occurrence so a slept-through night fires once, not a
// stack of catch-ups.
export const NIGHT_FLIGHT_PROMPT =
  "Night flight: reread today, pin anything worth carrying, and note one thing for tomorrow. Two short lines.";

const NIGHT_FLIGHT_RULE = "FREQ=DAILY;BYHOUR=3";
const NIGHT_FLIGHT_KEY = "nightflight:last_at";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The most recent 03:00 local occurrence still owed a flight, or null. */
export function nightFlightDue(nowMs: number = now(), tz: string = localZone()): number | null {
  if (!config.nightFlight) return null;
  // Yesterday+now bounds the search to the last night only, so a long outage
  // yields at most one flight.
  const occurrence = computeNextFire(NIGHT_FLIGHT_RULE, tz, nowMs - 24 * 60 * 60_000);
  if (occurrence == null || occurrence > nowMs) return null;
  const last = Number(getMeta(NIGHT_FLIGHT_KEY) ?? 0);
  return last >= occurrence ? null : occurrence;
}

export async function tickNightFlight(): Promise<number> {
  const at = nightFlightDue();
  if (at == null) return 0;
  // Claim before firing: a crash mid-flight must not double-run the night.
  setMeta(NIGHT_FLIGHT_KEY, String(at));
  const hoots = db
    .prepare(
      `SELECT h.id, t.id AS bough_id FROM hoots h
       JOIN threads t ON t.hoot_id = h.id AND t.kind = 'bough'
       WHERE h.status = 'active'`
    )
    .all() as any[];
  let fired = 0;
  for (const h of hoots) {
    try {
      await startTurn({
        threadId: h.bough_id,
        trigger: "automation",
        message: NIGHT_FLIGHT_PROMPT,
        surface: "silent",
      });
      fired += 1;
    } catch (err: any) {
      console.log(`[perch] night flight skipped for hoot ${h.id}: ${err?.message ?? err}`);
    }
  }
  console.log(`[perch] night flight for ${localDate(at)} → ${fired}/${hoots.length} active hoot(s)`);
  return fired;
}

export function startScheduler(deliverFn?: (hootId: string, text: string) => Promise<void>) {
  const tick = () => {
    tickScheduler(deliverFn)
      .catch(() => {})
      .then(() => tickNightFlight())
      .catch(() => {});
  };
  const t = setInterval(tick, 60_000);
  // also catch up once at boot (coalesced missed fires)
  setTimeout(tick, 3_000);
  return t;
}
