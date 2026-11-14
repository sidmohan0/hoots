// Computer-use session: policy, step audit, and the approval gate.
//
// Default posture is maximal freedom (DECISIONS.md #14): observe and navigate
// freely. Guardrails sit on *consequential* moments only — submissions,
// purchasing, deletions — which pause for one-tap approval unless the hoot is
// set to `auto`.
import { db, now, uuid } from "../db.js";
import { config } from "../config.js";
import { bus } from "../stream.js";
import { logger } from "../log.js";
import type { Driver, OcrBox } from "./driver.js";
import { driver as darwin } from "./platform.js";

/** Click labels that make an action consequential. */
const SUBMIT_LABELS = [
  "send", "submit", "post", "publish", "pay", "buy", "purchase", "place order",
  "confirm", "book", "reserve", "subscribe", "donate", "transfer", "delete",
  "remove", "deploy", "merge", "approve", "save changes", "sign",
  "checkout", "continue to payment", "install",
];

export type ComputerMode = "confirm" | "auto" | "off";

export function modeOf(hoot: any): ComputerMode {
  const m = hoot?.computer_mode;
  if (m === "off") return "off";
  if (m === "auto") return "auto";
  return config.computerEnabled ? "confirm" : "off";
}

export function looksConsequential(label: string | null | undefined, chord?: string): boolean {
  if (chord) {
    const c = chord.toLowerCase();
    // Plain Return is usually navigation (address bars, dialogs); only the
    // command-return "submit" idiom and ask_before gate by default.
    if (/^\w+\+(\w+\+)*(return|enter)$/.test(c)) return true;
  }
  if (!label) return false;
  const t = label.toLowerCase().trim();
  return SUBMIT_LABELS.some((s) => t === s || t.startsWith(s + " ") || t.endsWith(" " + s) || t.includes(s));
}

export type Session = {
  id: string;
  hootId: string;
  threadId: string;
  turnId: string;
  mode: ComputerMode;
  steps: number;
  shots: string;
  driver: Driver;
  lastWindows: string[];
};

const MAX_STEPS = Number(process.env.PERCH_COMPUTER_MAX_STEPS ?? 60);

export function openSession(opts: { hoot: any; threadId: string; turnId: string }): Session {
  const dir = `${config.dataDir}/shots/${opts.turnId}`;
  return {
    id: uuid(),
    hootId: opts.hoot.id,
    threadId: opts.threadId,
    turnId: opts.turnId,
    mode: modeOf(opts.hoot),
    steps: 0,
    shots: dir,
    driver: darwin,
    lastWindows: [],
  };
}

// --- approvals ---------------------------------------------------------------

export type Decision = "approved" | "denied" | "timeout";

const waiting = new Map<string, (d: Decision) => void>();

export async function requestApproval(
  session: Session,
  summary: string,
  kind: "submit" | "note"
): Promise<Decision> {
  if (session.mode === "auto") return "approved";
  if (session.mode === "off") return "approved";
  const id = uuid();
  db.prepare(
    `INSERT INTO approvals (id, turn_id, thread_id, hoot_id, summary, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, session.turnId, session.threadId, session.hootId, summary, kind, now());
  bus.publish({ event: "approval.request", data: { id, summary, kind, turn_id: session.turnId } });
  logger.info("computer: approval requested", { id, summary: summary.slice(0, 120) });
  const decision = await new Promise<Decision>((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => {
      if (waiting.has(id)) decide(id, "timeout");
    }, 10 * 60_000).unref?.();
  });
  return decision;
}

export function decide(id: string, decision: Decision): boolean {
  const resolve = waiting.get(id);
  if (!resolve) return false;
  waiting.delete(id);
  db.prepare(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?`).run(decision, now(), id);
  bus.publish({ event: "approval.decided", data: { id, decision } });
  resolve(decision);
  return true;
}

// --- step audit --------------------------------------------------------------

export type StepResult = { summary: string; shotId: string | null; detail?: unknown };

/** Every action leaves a receipt: what, where, and a screenshot. */
export async function recordStep(
  session: Session,
  action: string,
  target: string,
  opts: { shot?: boolean; detail?: unknown } = {}
): Promise<StepResult> {
  session.steps += 1;
  if (session.steps > MAX_STEPS) throw new Error(`step budget exhausted (${MAX_STEPS})`);
  let shotId: string | null = null;
  if (opts.shot !== false) {
    try {
      const cap = await session.driver.capture();
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(session.shots, { recursive: true });
      shotId = `${session.steps}-${Date.now()}.jpg`;
      writeFileSync(`${session.shots}/${shotId}`, cap.jpeg);
    } catch {
      shotId = null; // capture is best-effort; never fail the action over it
    }
  }
  return { summary: `${action} · ${target}`, shotId, detail: opts.detail };
}

// --- element targeting -------------------------------------------------------

/** Resolve a label to the best matching OCR box (topmost, small-distance wins). */
export function pickBox(boxes: OcrBox[], label: string): OcrBox | null {
  const needle = label.toLowerCase().trim();
  const scored = boxes
    .map((b) => {
      const t = b.text.toLowerCase();
      let score = 0;
      if (t === needle) score += 100;
      else if (t.startsWith(needle)) score += 60;
      else if (t.includes(needle)) score += 30;
      // prefer tighter boxes (buttons are small)
      score += Math.max(0, 20 - b.w / 40);
      return { b, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.b ?? null;
}

export const boxCentre = (b: OcrBox) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });
