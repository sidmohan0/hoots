// Day digests: one line per past day, generated lazily on first view
// (DECISIONS.md #9). A digest sees only that day's items of that bough.
import OpenAI from "openai";
import { db, now } from "./db.js";
import { config } from "./config.js";
import { logOutbound } from "./outbound.js";

export function getDigest(hootId: string, date: string): string | null {
  const row = db.prepare(`SELECT text FROM day_digests WHERE hoot_id = ? AND date = ?`).get(hootId, date) as any;
  return row?.text ?? null;
}

export async function ensureDigest(hootId: string, date: string): Promise<string | null> {
  const existing = getDigest(hootId, date);
  if (existing !== null) return existing;
  // Today isn't digestible yet.
  const today = new Date().toISOString().slice(0, 10);
  if (date >= today) return null;

  const bough = db.prepare(`SELECT id FROM threads WHERE hoot_id = ? AND kind = 'bough'`).get(hootId) as any;
  if (!bough) return null;
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000;
  const items = db
    .prepare(
      `SELECT created_at, content FROM items WHERE thread_id = ? AND kind = 'message' AND created_at >= ? AND created_at < ? ORDER BY created_at`
    )
    .all(bough.id, dayStart, dayEnd) as any[];
  if (!items.length) {
    // An empty day gets an empty digest — never re-ask.
    db.prepare(`INSERT INTO day_digests (hoot_id, date, text, generated_at) VALUES (?, ?, '', ?)`).run(hootId, date, now());
    return "";
  }

  const convo = items
    .map((i) => `${new Date(i.created_at).toISOString().slice(11, 16)}: ${String(JSON.parse(i.content)?.text ?? "").slice(0, 400)}`)
    .join("\n")
    .slice(0, 12_000);

  const client = new OpenAI({ baseURL: config.openaiBaseUrl, apiKey: config.openaiApiKey });
  const payload = JSON.stringify({ date, messages: convo });
  try {
    logOutbound("model", `digest ${date}`, payload.length);
    const res = await client.chat.completions.create({
      model: "glm-5.3-flash-uncensored",
      messages: [
        {
          role: "system",
          content:
            "Write a one-line digest of this day's conversation between the user and the agent. Plain, warm, under 25 words. Mention what mattered, not pleasantries. Reply with the digest text only.",
        },
        { role: "user", content: payload },
      ],
      temperature: 0.3,
    });
    const text = (res.choices[0]?.message?.content ?? "").trim().slice(0, 200);
    db.prepare(`INSERT INTO day_digests (hoot_id, date, text, generated_at) VALUES (?, ?, ?, ?)`).run(hootId, date, text, now());
    return text;
  } catch {
    return null; // no digest yet; the UI shows the raw day instead
  }
}
