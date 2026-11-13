// herald-telegram: long-polling bridge. Inbound chat -> channel turn in the
// hoot's bough; outbound hoot messages -> reply to the originating chat.
import { db, now, uuid } from "./db.js";
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

export async function sendMessage(chatId: string, text: string, token: string) {
  await fetch(API(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
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
    const channels = db.prepare(`SELECT * FROM channels WHERE hoot_id = ? AND kind = 'telegram'`).all(thread.hoot_id) as any[];
    for (const ch of channels) {
      const raw = item.content;
      const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : raw;
      const text = parsed?.text;
      if (text) await sendMessage(ch.external_id, text, token).catch(() => {});
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
          await startTurn({ threadId: bough.id, trigger: "channel", message: text });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  poll();
  return () => { stopped = true; };
}
