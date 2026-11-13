// herald-telegram: long-polling bridge. Inbound chat -> channel turn in the
// hoot's bough; outbound hoot messages -> reply to the originating chat.
import { db, now, uuid } from "./db.js";
import { logOutbound } from "./outbound.js";
import { startTurn } from "./turns.js";
import { bus } from "./stream.js";

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export function bindChannel(hootId: string, chatId: string) {
  db.prepare(
    `INSERT INTO channels (id, hoot_id, kind, external_id, created_at)
     VALUES (?, ?, 'telegram', ?, ?)
     ON CONFLICT(kind, external_id) DO UPDATE SET hoot_id = excluded.hoot_id`
  ).run(uuid(), hootId, String(chatId), now());
}

export function channelForChat(chatId: string) {
  return db
    .prepare(`SELECT * FROM channels WHERE kind = 'telegram' AND external_id = ?`)
    .get(String(chatId)) as any;
}

// --- markdown → Telegram HTML (small sanitized subset) ----------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toTelegramHtml(md: string): string {
  const blocks = md.split(/```/);
  return blocks
    .map((block, i) => {
      if (i % 2 === 1) return `<pre>${esc(block.replace(/^\w*\n/, ""))}</pre>`;
      let t = esc(block);
      t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
      t = t.replace(/^&gt; ?(.*)$/gm, "<blockquote>$1</blockquote>");
      t = t.replace(/^[-•] (.*)$/gm, "• $1");
      t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
      return t;
    })
    .join("");
}

// Telegram caps messages at 4096 chars; split on line/paragraph edges.
export function chunk(text: string, limit = 3900): string[] {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send with 429 retry_after honouring and 5xx backoff (max 3 tries). */
export async function sendMessage(chatId: string, markdown: string, token: string) {
  const parts = chunk(markdown);
  for (const [i, part] of parts.entries()) {
    const body = JSON.stringify({
      chat_id: chatId,
      text: parts.length > 1 ? `${part}\n\n(${i + 1}/${parts.length})` : part,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    logOutbound("telegram", `reply → chat ${chatId}`, body.length);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(API(token, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.ok) break;
      const err: any = await res.json().catch(() => ({}));
      if (res.status === 429) {
        await sleep(Math.min(30_000, ((err?.parameters?.retry_after ?? 2) + 1) * 1000));
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(attempt * 750);
        continue;
      }
      // parse_mode regression safety: retry once as plain text
      if (res.status === 400 && attempt === 1) {
        await fetch(API(token, "sendMessage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: part }),
        }).catch(() => {});
      }
      break;
    }
    if (parts.length > 1) await sleep(120);
  }
}

export function startTelegramHerald(token: string) {
  let offset = 0;
  let stopped = false;

  // Fan-out: any hoot message item gets delivered to bound telegram chats.
  bus.on("event", async (ev: any) => {
    if (ev.event !== "item.append") return;
    const item = ev.data.item;
    if (item.kind !== "message" || item.role !== "hoot") return;
    const thread = db.prepare(`SELECT hoot_id FROM threads WHERE id = ?`).get(item.thread_id) as any;
    if (!thread) return;
    // Reply-where-spoken (DECISIONS.md, board 07): a turn answers on the
    // surface it came from; it shows on both. Web-origin replies stay in the
    // web; Telegram-origin and automation turns push to Telegram.
    const turn = db.prepare(`SELECT origin_surface FROM turns WHERE id = ?`).get(item.turn_id) as any;
    const origin = turn?.origin_surface ?? "web";
    if (origin !== "telegram" && origin !== "system") return;
    const channels = db.prepare(`SELECT * FROM channels WHERE hoot_id = ? AND kind = 'telegram'`).all(thread.hoot_id) as any[];
    for (const ch of channels) {
      const raw = item.content;
      const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : raw;
      const text = parsed?.text;
      if (text) {
        // While a web tab is focused (read within 60s), don't buzz the phone.
        const rs = db.prepare(`SELECT last_read_at FROM read_state WHERE hoot_id = ? AND surface = 'web'`).get(thread.hoot_id) as any;
        const webFocused = rs?.last_read_at && Date.now() - rs.last_read_at < 60_000;
        if (!webFocused) {
          await sendMessage(ch.external_id, text, token).catch(() => {});
          db.prepare(`UPDATE items SET delivered = CASE WHEN delivered = '' THEN 'telegram' ELSE delivered || ',telegram' END WHERE id = ?`)
            .run(item.id);
        }
      }
    }
  });

  async function poll() {
    while (!stopped) {
      try {
        const res = await fetch(API(token, "getUpdates"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ timeout: 30, offset }),
        });
        const data: any = await res.json();
        for (const upd of data.result ?? []) {
          offset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg?.text) continue;
          const ch = channelForChat(msg.chat.id);
          if (!ch) continue; // unbound chats are ignored until bound via API
          const bough = db
            .prepare(`SELECT id FROM threads WHERE hoot_id = ? AND kind = 'bough'`)
            .get(ch.hoot_id) as any;
          if (!bough) continue;
          const text = msg.text === "/start" ? "Hello!" : msg.text;
          // Telegram surface: record inbound activity for "last heard from you"
          db.prepare(
            `INSERT INTO read_state (hoot_id, surface, last_read_at) VALUES (?, 'telegram', ?)
             ON CONFLICT(hoot_id, surface) DO UPDATE SET last_read_at = excluded.last_read_at`
          ).run(ch.hoot_id, now());
          await startTurn({ threadId: bough.id, trigger: "channel", message: text, surface: "telegram" });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  poll();
  return () => { stopped = true; };
}
