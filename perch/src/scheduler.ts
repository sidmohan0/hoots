import rrulePkg from "rrule";
// rrule ships CJS without an exports map; destructure via default interop.
const { RRule } = rrulePkg as any;
import { db, now, uuid } from "./db.js";
import { startTurn } from "./turns.js";
import { bus } from "./stream.js";

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
