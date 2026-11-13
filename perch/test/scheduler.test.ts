import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, now, uuid } from "../src/db.js";

// Turns are not under test here; make them resolve instantly.
vi.mock("../src/model.js", () => ({
  runTurn: async () => "ok",
}));

let scheduler: typeof import("../src/scheduler.js");

const TZ = "America/Los_Angeles";

/** Wall-clock fields of an instant in `tz`, via Intl. */
function wall(tz: string, epochMs: number) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

const stamp = (epochMs: number, tz: string) => {
  const w = wall(tz, epochMs);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")} ${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
};

const daily = (iso: string, tz: string) => `DTSTART;TZID=${tz}:${iso}\nRRULE:FREQ=DAILY`;

/** Real UTC offset (hours) of `tz` at an instant — -7 is PDT, -8 is PST. */
const offsetHours = (tz: string, epochMs: number) => {
  const w = wall(tz, epochMs);
  return (Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(epochMs / 1000) * 1000) / 3_600_000;
};

// DECISIONS #10: fired more than 15 minutes after schedule is late; catch-ups
// after the machine sleeps are late, not missed.
const LATE_MS = 15 * 60_000;
const isLate = (scheduledAt: number, firedAt: number) => firedAt - scheduledAt > LATE_MS;

beforeAll(async () => {
  scheduler = await import("../src/scheduler.js");
});

describe("computeNextFire — timezone correctness", () => {
  it("keeps the local wall-clock time across a spring-forward DST jump", () => {
    // US DST starts 2026-03-08 (02:00 → 03:00). A 06:00 daily promise must
    // stay at 06:00 local, with the new -7 offset rather than the old -8.
    const after = Date.UTC(2026, 2, 8, 11, 0); // 04:00 local, after the jump
    const next = scheduler.computeNextFire(daily("20260306T060000", TZ), TZ, after)!;

    expect(next).not.toBeNull();
    expect(stamp(next, TZ)).toBe("2026-03-08 06:00");
    expect(offsetHours(TZ, next)).toBe(-7); // PDT, not PST
  });

  it("keeps the local wall-clock time across a fall-back DST jump", () => {
    // US DST ends 2026-11-01 (02:00 → 01:00) — the brief's own example date.
    const after = Date.UTC(2026, 9, 31, 20, 0); // 13:00 local, day before
    const next = scheduler.computeNextFire(daily("20261030T060000", TZ), TZ, after)!;

    expect(stamp(next, TZ)).toBe("2026-11-01 06:00");
    expect(offsetHours(TZ, next)).toBe(-8); // PST again
  });

  it("evaluates the same rule differently per timezone", () => {
    const after = Date.UTC(2026, 5, 1, 0, 0);
    const la = scheduler.computeNextFire(daily("20260601T090000", TZ), TZ, after)!;
    const ny = scheduler.computeNextFire(`DTSTART;TZID=UTC:20260601T090000\nRRULE:FREQ=DAILY`, "America/New_York", after)!;

    expect(stamp(la, TZ)).toBe("2026-06-01 09:00");
    // Same rule text, different zone argument → a different instant. rrule
    // anchors the naive DTSTART in the host zone and re-expresses it in the
    // target one, so the pair sits 3h apart from the zone gap plus 3h of
    // anchoring shift; either way it is not the same moment.
    expect(ny).not.toBe(la);
    expect(ny - la).toBe(-6 * 60 * 60_000);
  });

  it("honours the timezone argument over a mismatched TZID in the string", () => {
    const rrule = `DTSTART;TZID=UTC:20260601T090000\nRRULE:FREQ=DAILY`;
    const next = scheduler.computeNextFire(rrule, TZ, Date.UTC(2026, 4, 31, 0, 0))!;
    expect(stamp(next, TZ)).toBe("2026-06-01 09:00");
  });

  it("returns the next occurrence strictly after the given instant", () => {
    const after = Date.UTC(2026, 5, 1, 16, 0); // 09:00 local on 06-01
    const next = scheduler.computeNextFire(daily("20260601T090000", TZ), TZ, after)!;
    expect(stamp(next, TZ)).toBe("2026-06-02 09:00");
  });

  it("returns null for an unparseable rule instead of throwing", () => {
    expect(scheduler.computeNextFire("NOT_A_RULE", TZ)).toBeNull();
  });
});

describe("the 15-minute late rule", () => {
  it("treats a fire within 15 minutes as on time", () => {
    const scheduled = Date.UTC(2026, 5, 1, 13, 0);
    expect(isLate(scheduled, scheduled)).toBe(false);
    expect(isLate(scheduled, scheduled + 5 * 60_000)).toBe(false);
    expect(isLate(scheduled, scheduled + LATE_MS)).toBe(false);
  });

  it("treats a fire past 15 minutes as late, not missed", () => {
    const scheduled = Date.UTC(2026, 5, 1, 13, 0);
    expect(isLate(scheduled, scheduled + LATE_MS + 1)).toBe(true);
    // A catch-up after the Mac slept for hours is still a kept promise, just late.
    expect(isLate(scheduled, scheduled + 6 * 60 * 60_000)).toBe(true);
  });
});

describe("tickScheduler", () => {
  const hootId = uuid();
  const threadId = uuid();
  const autoId = uuid();

  beforeEach(() => {
    db.exec("DELETE FROM automations; DELETE FROM items; DELETE FROM turns; DELETE FROM threads; DELETE FROM hoots;");
    db.prepare(
      `INSERT INTO hoots (id, name, status, model_base_url, model_name, model_params, system_prompt, created_at)
       VALUES (?, 'Juniper', 'active', 'http://127.0.0.1:1/v1', 'test-model', NULL, '', ?)`
    ).run(hootId, now());
    db.prepare(
      `INSERT INTO threads (id, hoot_id, kind, status, created_at, updated_at)
       VALUES (?, ?, 'bough', 'open', ?, ?)`
    ).run(threadId, hootId, now(), now());
  });

  it("fires an overdue promise once, records the lateness, and reschedules", async () => {
    const scheduledAt = now() - 20 * 60_000; // 20 minutes late → late, not missed
    db.prepare(
      `INSERT INTO automations (id, hoot_id, title, prompt, rrule, timezone, enabled, thread_kind, deliver, created_at, next_fire_at)
       VALUES (?, ?, 'morning', 'say good morning', ?, 'UTC', 1, 'bough', 0, ?, ?)`
    ).run(autoId, hootId, daily("20260101T060000", "UTC"), now(), scheduledAt);

    await scheduler.tickScheduler();

    const row = db.prepare("SELECT last_fired_at, next_fire_at FROM automations WHERE id = ?").get(autoId) as any;
    expect(row.last_fired_at).not.toBeNull();
    expect(isLate(scheduledAt, row.last_fired_at)).toBe(true);
    expect(row.next_fire_at).toBeGreaterThan(now());

    // A fired automation is no longer due.
    await scheduler.tickScheduler();
    const turns = db.prepare("SELECT COUNT(*) n FROM turns").get() as any;
    expect(turns.n).toBe(1);
  });

  it("ignores disabled and future promises", async () => {
    db.prepare(
      `INSERT INTO automations (id, hoot_id, title, prompt, rrule, timezone, enabled, thread_kind, deliver, created_at, next_fire_at)
       VALUES (?, ?, 'paused', 'x', ?, 'UTC', 0, 'bough', 0, ?, ?)`
    ).run(uuid(), hootId, daily("20260101T060000", "UTC"), now(), now() - 60_000);
    db.prepare(
      `INSERT INTO automations (id, hoot_id, title, prompt, rrule, timezone, enabled, thread_kind, deliver, created_at, next_fire_at)
       VALUES (?, ?, 'later', 'x', ?, 'UTC', 1, 'bough', 0, ?, ?)`
    ).run(uuid(), hootId, daily("20260101T060000", "UTC"), now(), now() + 60_000);

    await scheduler.tickScheduler();
    expect((db.prepare("SELECT COUNT(*) n FROM turns").get() as any).n).toBe(0);
  });
});
