import OpenAI from "openai";
import { db, now, getMeta, setMeta, uuid } from "./db.js";
import { logOutbound } from "./outbound.js";
import { bus } from "./stream.js";
import { config } from "./config.js";

// The pellet is a hoot's long-term memory: a rolling summary of its bough plus
// a set of durable facts. Pinned facts (from `remember` note items) persist
// forever; the model may add or retire other facts as the bough grows.
//
// State lives in meta under `pellet:<hootId>`:
//   { facts, summary, generated_at, cursor_item_id }
// `cursor_item_id` is the newest bough item already folded into the summary;
// regeneration processes only items after it.

export type Pellet = {
  facts: string[];
  summary: string;
  generated_at: number | null;
  cursor_item_id: string | null;
};

// Flash model used for pellet summarization (OpenAI-compatible endpoint).
const PELLET_MODEL = "glm-5.3-flash-uncensored";

const MAX_NEW_ITEMS = 120;
const MAX_NEW_WORDS = 8000;
const MAX_PELLET_WORDS = 800;
const MAX_FACTS = 60;

const EMPTY_PELLET: Pellet = { facts: [], summary: "", generated_at: null, cursor_item_id: null };

const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function pelletKey(hootId: string) {
  return `pellet:${hootId}`;
}

function normalizePellet(v: any): Pellet {
  return {
    facts: Array.isArray(v?.facts) ? v.facts.map(String).filter(Boolean) : [],
    summary: typeof v?.summary === "string" ? v.summary : "",
    generated_at: typeof v?.generated_at === "number" ? v.generated_at : null,
    cursor_item_id: typeof v?.cursor_item_id === "string" ? v.cursor_item_id : null,
  };
}

export function getPellet(hootId: string): Pellet {
  const raw = getMeta(pelletKey(hootId));
  if (raw === null) return { ...EMPTY_PELLET };
  try {
    return normalizePellet(JSON.parse(raw));
  } catch {
    return { ...EMPTY_PELLET };
  }
}

function savePellet(hootId: string, pellet: Pellet): void {
  setMeta(pelletKey(hootId), JSON.stringify(pellet));
}

// Pinned facts come straight from `remember` note items; the bough is the
// source of truth, so they survive every regeneration.
function pinnedFacts(hootId: string): string[] {
  const rows = db
    .prepare(
      `SELECT i.content FROM items i JOIN threads t ON t.id = i.thread_id
       WHERE t.hoot_id = ? AND i.kind = 'note' ORDER BY i.created_at DESC LIMIT 500`
    )
    .all(hootId) as any[];
  const facts = new Set<string>();
  for (const r of rows) {
    try {
      const note = JSON.parse(r.content);
      if (note?.undone) continue; // "won't remember this" — stays undone
      const fact = note?.fact;
      if (typeof fact === "string" && fact.trim()) facts.add(fact.trim());
    } catch {
      // skip malformed note content
    }
  }
  return [...facts];
}

// Newest bough message items not yet folded into the pellet, oldest first,
// capped by item count and word budget.
function newBoughMessages(hootId: string, cursorItemId: string | null) {
  const cursor = cursorItemId
    ? (db.prepare("SELECT rowid FROM items WHERE id = ?").get(cursorItemId) as any)
    : undefined;
  const rows = (
    cursor
      ? db
          .prepare(
            `SELECT i.id, i.created_at, i.content FROM items i
             JOIN threads t ON t.id = i.thread_id
             WHERE t.hoot_id = ? AND t.kind = 'bough' AND i.kind = 'message' AND i.rowid > ?
             ORDER BY i.rowid ASC`
          )
          .all(hootId, cursor.rowid)
      : db
          .prepare(
            `SELECT i.id, i.created_at, i.content FROM items i
             JOIN threads t ON t.id = i.thread_id
             WHERE t.hoot_id = ? AND t.kind = 'bough' AND i.kind = 'message'
             ORDER BY i.rowid ASC`
          )
          .all(hootId)
  ) as any[];

  let batch = rows.slice(-MAX_NEW_ITEMS);
  let words = batch.reduce((n, r) => n + countWords(String(JSON.parse(r.content)?.text ?? "")), 0);
  while (batch.length && words > MAX_NEW_WORDS) {
    words -= countWords(String(JSON.parse(batch[0].content)?.text ?? ""));
    batch = batch.slice(1);
  }
  return batch;
}

// Strip code fences / stray prose around a JSON object.
function parseModelJson(raw: string): any | null {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

// Keep the whole pellet under ~800 words: drop oldest facts first, then
// truncate the summary.
function fitPellet(p: Pellet): Pellet {
  const facts = [...p.facts].slice(-MAX_FACTS);
  const factWords = () => facts.reduce((n, f) => n + countWords(f), 0);
  while (facts.length && countWords(p.summary) + factWords() > MAX_PELLET_WORDS) facts.shift();
  let summary = p.summary;
  if (countWords(summary) + factWords() > MAX_PELLET_WORDS) {
    const budget = Math.max(0, MAX_PELLET_WORDS - factWords());
    summary = summary.trim().split(/\s+/).slice(0, budget).join(" ");
  }
  return { ...p, facts, summary };
}

type FactAdd = { text: string; category?: string; guess?: boolean };
async function askModel(current: Pellet, batch: any[]): Promise<{ summary: string; add: FactAdd[]; remove: string[] }> {
  const client = new OpenAI({ baseURL: config.openaiBaseUrl, apiKey: config.openaiApiKey });
  const messages = batch.map((r) => ({
    at: new Date(r.created_at).toISOString(),
    text: String(JSON.parse(r.content)?.text ?? ""),
  }));
  const prompt =
    "Update the rolling summary and extract durable facts about the user.\n\n" +
    "Reply with ONLY a JSON object of the shape:\n" +
    '{"summary": string, "facts_update": {"add": [{"text": string, "category": string, "guess": boolean}], "remove": string[]}}\n\n' +
    '- "summary": an updated rolling summary of the agent\'s shared history with the user, under 300 words.\n' +
    '- "facts_update.add": new durable facts worth remembering. Each has "text" (the literal fact), "category" (one of: person, project, routine, preference, date, other), and "guess" (true when the fact is an inference rather than something the user said outright).\n' +
    '- "facts_update.remove": exact copies of existing durable facts that are no longer true or no longer relevant.\n' +
    "Do not remove pinned facts. Reply with JSON only, no prose.";

  const userPayload = JSON.stringify({
    current_summary: current.summary,
    durable_facts: current.facts,
    new_messages: messages,
  });

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      logOutbound("model", "pellet refresh", userPayload.length);
      const res = await client.chat.completions.create({
        model: PELLET_MODEL,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userPayload },
        ],
        temperature: 0.2,
      });
      const text = res.choices[0]?.message?.content ?? "";
      const parsed = parseModelJson(text);
      if (!parsed || typeof parsed.summary !== "string" || typeof parsed.facts_update !== "object") {
        throw new Error("unparseable pellet response");
      }
      const rawAdd = Array.isArray(parsed.facts_update.add) ? parsed.facts_update.add : [];
      const add: FactAdd[] = rawAdd
        .map((f: any) => (typeof f === "string" ? { text: f } : { text: String(f?.text ?? ""), category: f?.category, guess: !!f?.guess }))
        .filter((f: FactAdd) => f.text.trim());
      const remove: string[] = Array.isArray(parsed.facts_update.remove) ? parsed.facts_update.remove.map(String) : [];
      return { summary: parsed.summary, add, remove };
    } catch (err) {
      lastErr = err;
      // parse failures retry once; a second failure falls through to "keep previous"
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Regenerate the pellet for a hoot. Without an API key this is a no-op that
// returns the existing pellet unchanged. On model or parse failure the
// previous pellet is kept and returned unchanged.
export async function regeneratePellet(hootId: string): Promise<Pellet> {
  if (!config.openaiApiKey) return getPellet(hootId);

  const current = getPellet(hootId);
  const batch = newBoughMessages(hootId, current.cursor_item_id);

  // Nothing new to fold in — don't spend a model call.
  if (!batch.length) return current;

  try {
    const { summary, add, remove } = await askModel(current, batch);

    // Pinned facts (note items) always survive; removes apply to model-added
    // facts only. Previously model-added facts carry over between generations.
    const pinned = new Set(pinnedFacts(hootId));
    const removable = current.facts.filter((f) => !pinned.has(f));
    const removeSet = new Set(remove.map((r) => r.trim().toLowerCase()).filter(Boolean));
    const kept = removable.filter((f) => !removeSet.has(f.trim().toLowerCase()));
    const merged = [...pinned];
    for (const f of [...kept, ...add.map((a) => a.text)]) {
      const key = f.trim();
      if (key && !pinned.has(key) && !merged.some((m) => m.toLowerCase() === key.toLowerCase())) merged.push(key);
    }

    const cursorItemId = batch[batch.length - 1].id;

    // Persist fact adds/removes to the facts table (DECISIONS.md #13).
    const existing = db
      .prepare(`SELECT id, text, confidence FROM facts WHERE hoot_id = ? AND forgotten_at IS NULL`)
      .all(hootId) as any[];
    for (const f of add) {
      const key = f.text.trim().toLowerCase();
      if (existing.some((e) => e.text.toLowerCase() === key)) continue;
      db.prepare(
        `INSERT INTO facts (id, hoot_id, text, category, scope, source_item_id, confidence, created_at)
         VALUES (?, ?, ?, ?, 'hoot', ?, ?, ?)`
      ).run(uuid(), hootId, f.text.trim(), f.category ?? null, cursorItemId, f.guess ? "extracted" : "confirmed", now());
    }
    for (const r of remove) {
      const key = r.trim().toLowerCase();
      const row = existing.find((e) => e.text.toLowerCase() === key && e.confidence !== "pinned");
      if (row) db.prepare(`UPDATE facts SET forgotten_at = ? WHERE id = ?`).run(now(), row.id);
    }

    const next = fitPellet({ facts: merged, summary, generated_at: now(), cursor_item_id: cursorItemId });
    savePellet(hootId, next);
    bus.publish({ event: "fact.changed", data: { hoot_id: hootId } });
    return next;
  } catch {
    return current;
  }
}

// Rendered for injection into the system prompt ahead of the recent window.
export function pelletContextBlock(hootId: string): string {
  const p = getPellet(hootId);
  const facts = db
    .prepare(
      `SELECT text FROM facts WHERE forgotten_at IS NULL AND (hoot_id = ? OR scope = 'global')
       ORDER BY created_at LIMIT 60`
    )
    .all(hootId) as any[];
  const parts: string[] = [];
  if (facts.length) {
    parts.push(`Long-term memory:\n${facts.map((f) => `- ${f.text}`).join("\n")}`);
  }
  if (p.summary) {
    parts.push(`Summary of our history: ${p.summary}`);
  }
  return parts.join("\n");
}

/** remember() writes a pinned fact: note item + facts row in one go. */
export function pinFact(hootId: string, text: string, sourceItemId: string | null): void {
  db.prepare(
    `INSERT INTO facts (id, hoot_id, text, category, scope, source_item_id, confidence, created_at)
     VALUES (?, ?, ?, 'other', 'hoot', ?, 'pinned', ?)`
  ).run(uuid(), hootId, text, sourceItemId, now());
}
