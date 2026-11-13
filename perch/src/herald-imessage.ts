// herald-imessage: macOS-only bridge over Messages.app. Outbound goes through
// `osascript` (Apple Events); inbound is a read-only poll of the local
// Messages database. Two one-time macOS permissions are required — see the
// hints below. Opt-in: PERCH_IMESSAGE=true + PERCH_IMESSAGE_BUDDY.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { db, getMeta, setMeta } from "./db.js";
import { logOutbound } from "./outbound.js";
import { channelFor, bindSurface, type Herald } from "./herald.js";

const OSASCRIPT = "/usr/bin/osascript";
const CHAT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");
const POLL_MS = 5_000;
const CHUNK = 3500;
const LAST_ROWID = "imessage:last_rowid";

const AUTOMATION_HINT =
  "[perch] herald-imessage: Messages refused the send (-1743). Grant automation: " +
  "System Settings › Privacy & Security › Automation › <your terminal> › Messages. Then restart the perch.";

const FDA_HINT =
  "[perch] herald-imessage: cannot open ~/Library/Messages/chat.db (SQLITE_CANTOPEN). " +
  "Grant Full Disk Access: System Settings › Privacy & Security › Full Disk Access › <your terminal>. Then restart the perch.";

// One noisy hint per process is enough; the fix needs a restart anyway.
let automationHinted = false;
let fdaHinted = false;

export function buddies(raw: string): string[] {
  return raw.split(",").map((b) => b.trim()).filter(Boolean);
}

/** Same buddy, however the Messages DB spells it (digits vs formatted). */
export function sameHandle(a: string, b: string): boolean {
  // Emails compare case-insensitively; phone handles compare on their digits,
  // so "+1 (555) 010-9999" still matches "+15550109999".
  const norm = (s: string) => (s.includes("@") ? s.trim().toLowerCase() : s.replace(/[^\d]/g, ""));
  const na = norm(a);
  return na !== "" && na === norm(b);
}

const applescriptQuote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Messages caps its own bubble length; keep each script well under it.
export function chunk(text: string, limit = CHUNK): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function script(handle: string, text: string): string {
  return `tell application "Messages"
  set targetService to missing value
  repeat with s in services
    if service type of s is in {iMessage, SMS} then
      try
        set targetBuddy to participant "${applescriptQuote(handle)}" of s
        set targetService to s
        exit repeat
      end try
    end if
  end repeat
  if targetService is missing value then set targetService to 1st service whose service type = iMessage
  send "${applescriptQuote(text)}" to participant "${applescriptQuote(handle)}" of targetService
end tell`;
}

function osa(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ["-e", src], { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || err.message) }));
      else resolve();
    });
  });
}

/** Send one chunk to one buddy. Returns 1 on success, 0 when it was refused. */
async function sendTo(handle: string, text: string): Promise<number> {
  const body = script(handle, text);
  logOutbound("imessage", `send → ${handle}`, body.length);
  try {
    await osa(body);
    return 1;
  } catch (err: any) {
    const detail = String(err?.stderr ?? err?.message ?? err).trim().split("\n")[0];
    if (detail.includes("-1743") && !automationHinted) {
      automationHinted = true;
      console.log(AUTOMATION_HINT);
    } else if (detail.includes("-1743")) {
      // already hinted
    } else {
      console.log(`[perch] herald-imessage: send to ${handle} failed — ${detail}`);
    }
    return 0;
  }
}

function openInbox(): Database.Database | null {
  try {
    return new Database(CHAT_DB, { readonly: true, fileMustExist: true, timeout: 1000 });
  } catch (err: any) {
    const code = String(err?.code ?? err?.message ?? err);
    if (code.includes("SQLITE_CANTOPEN")) {
      if (!fdaHinted) {
        fdaHinted = true;
        console.log(FDA_HINT);
      }
    } else {
      console.log(`[perch] herald-imessage: inbox unavailable — ${code}`);
    }
    return null;
  }
}

type Inbound = { rowid: number; handle: string; text: string };

function readInbound(inbox: Database.Database, sinceRowid: number, handles: string[]): Inbound[] {
  const rows = inbox
    .prepare(
      `SELECT m.ROWID AS rowid, h.id AS handle, m.text AS text
       FROM message m JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL
       ORDER BY m.ROWID LIMIT 200`
    )
    .all(sinceRowid) as Inbound[];
  return rows.filter((r) => handles.some((b) => sameHandle(b, r.handle)));
}

function maxRowid(inbox: Database.Database): number {
  const row = inbox.prepare(`SELECT COALESCE(MAX(ROWID), 0) AS m FROM message`).get() as any;
  return row.m;
}

/** The hoot a buddy handle belongs to; unbound + single active hoot binds it. */
function hootForHandle(handle: string): string | null {
  const ch = channelFor("imessage", handle);
  if (ch) return ch.hoot_id;
  const hoots = db.prepare(`SELECT id FROM hoots WHERE status = 'active'`).all() as any[];
  if (hoots.length !== 1) return null;
  bindSurface(hoots[0].id, "imessage", handle);
  return hoots[0].id;
}

export function imessageHerald(buddyList: string): Herald {
  return {
    id: "herald-imessage",
    start(ctx) {
      const handles = buddies(buddyList);

      ctx.transport(async (text, hootId) => {
        if (!handles.length) return 0;
        // A hoot's iMessage binding narrows the fan-out; with no binding all
        // configured buddies are the hoot's people.
        const bound = (db
          .prepare(`SELECT external_id FROM channels WHERE hoot_id = ? AND kind = 'imessage'`)
          .all(hootId) as any[]).map((r) => r.external_id as string);
        const reach = bound.length ? bound : handles;
        let reached = 0;
        for (const handle of reach) {
          for (const part of chunk(text)) reached += await sendTo(handle, part);
        }
        return reached;
      });

      let stopped = false;
      let inbox: Database.Database | null = null;
      let seeded = false;

      async function poll() {
        while (!stopped) {
          inbox ??= openInbox();
          if (!inbox) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            continue;
          }
          try {
            if (!seeded) {
              // First sight of the db: jump to live rather than replay months.
              if (getMeta(LAST_ROWID) === null) setMeta(LAST_ROWID, String(maxRowid(inbox)));
              seeded = true;
            }
            const since = Number(getMeta(LAST_ROWID) ?? 0);
            const rows = readInbound(inbox, since, handles);
            for (const msg of rows) {
              const hootId = hootForHandle(msg.handle);
              if (hootId) await ctx.deliver(hootId, msg.handle, "imessage", msg.text);
            }
            if (rows.length) setMeta(LAST_ROWID, String(rows[rows.length - 1].rowid));
          } catch (err: any) {
            // Locked/unreadable mid-poll: drop the handle, reopen next tick.
            const code = String(err?.code ?? err?.message ?? err);
            try { inbox.close(); } catch { /* already gone */ }
            inbox = null;
            if (code.includes("SQLITE_CANTOPEN") && !fdaHinted) {
              fdaHinted = true;
              console.log(FDA_HINT);
            }
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        try { inbox?.close(); } catch { /* already gone */ }
      }
      poll();
      return () => { stopped = true; };
    },
  };
}
