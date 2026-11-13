import { db, now, uuid } from "./db.js";
import type { ToolDef } from "./model.js";

// Full-text recall over the hoot's bough history (messages + pinned notes),
// backed by the items_fts FTS5 index. Falls back to a plain LIKE scan if FTS
// errors out or matches nothing.

// Sanitize a user query into safe FTS5 syntax: split on whitespace and wrap
// each token in double quotes so operators/punctuation never break the parse.
function ftsMatchQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" ");
}

const RECALL_LIMIT = 10;

function likeRecall(hootId: string, query: string) {
  return db
    .prepare(
      `SELECT i.content, i.created_at FROM items i
       JOIN threads t ON t.id = i.thread_id
       WHERE t.hoot_id = ? AND i.kind IN ('message','note')
         AND lower(i.content) LIKE '%' || lower(?) || '%'
       ORDER BY i.created_at DESC LIMIT ${RECALL_LIMIT}`
    )
    .all(hootId, query);
}

function ftsRecall(hootId: string, match: string) {
  return db
    .prepare(
      `SELECT i.content, i.created_at FROM items_fts
       JOIN items i ON i.id = items_fts.item_id
       JOIN threads t ON t.id = i.thread_id
       WHERE items_fts MATCH ? AND t.hoot_id = ?
       ORDER BY bm25(items_fts) LIMIT ${RECALL_LIMIT}`
    )
    .all(match, hootId);
}

// v1 built-in talons (tools). Full-text recall + pin-to-pellet.
export function builtInTools(): ToolDef[] {
  return [
    {
      name: "recall",
      description:
        "Search the hoot's conversation history (its primary thread and pinned notes) for past messages and facts matching a keyword query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "keywords to search for" },
        },
        required: ["query"],
      },
      execute: (args: { query: string }, ctx) => {
        let rows: any[] = [];
        const match = ftsMatchQuery(args.query ?? "");
        if (match) {
          try {
            rows = ftsRecall(ctx.hootId, match) as any[];
          } catch {
            rows = []; // malformed index or query — fall through to LIKE
          }
        }
        if (!rows.length) rows = likeRecall(ctx.hootId, args.query ?? "") as any[];
        return rows.map((r: any) => ({ at: r.created_at, ...JSON.parse(r.content) }));
      },
    },
    {
      name: "remember",
      description: "Pin an important fact into long-term memory (included in the next pellet).",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string" },
        },
        required: ["fact"],
      },
      execute: (args: { fact: string }, ctx) => {
        const turn = db.prepare("SELECT thread_id FROM turns WHERE id = ?").get(ctx.turnId) as any;
        db.prepare(
          `INSERT INTO items (id, turn_id, thread_id, seq, kind, role, content, created_at)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM items WHERE turn_id = ?), 'note', NULL, ?, ?)`
        ).run(uuid(), ctx.turnId, turn.thread_id, ctx.turnId, JSON.stringify({ fact: args.fact }), now());
        return { ok: true };
      },
    },
  ];
}
