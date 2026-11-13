// herald-telegram: long-polling bridge. Inbound chat -> channel turn in the
// hoot's bough; outbound hoot messages -> reply to the originating chat.
import { db } from "./db.js";
import { logOutbound } from "./outbound.js";
import { bindSurface, channelFor, type Herald } from "./herald.js";

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export function bindChannel(hootId: string, chatId: string) {
  bindSurface(hootId, "telegram", chatId);
}

export function channelForChat(chatId: string) {
  return channelFor("telegram", chatId);
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

export function telegramHerald(token: string): Herald {
  return {
    id: "herald-telegram",
    start(ctx) {
      // Outbound: every chat bound to this hoot on this surface.
      ctx.transport(async (text, hootId) => {
        const channels = db
          .prepare(`SELECT * FROM channels WHERE hoot_id = ? AND kind = 'telegram'`)
          .all(hootId) as any[];
        for (const ch of channels) await sendMessage(ch.external_id, text, token).catch(() => {});
        return channels.length;
      });

      let offset = 0;
      let stopped = false;

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
              const text = msg.text === "/start" ? "Hello!" : msg.text;
              await ctx.deliver(ch.hoot_id, String(msg.chat.id), "telegram", text);
            }
          } catch {
            await sleep(5000);
          }
        }
      }
      poll();
      return () => { stopped = true; };
    },
  };
}
