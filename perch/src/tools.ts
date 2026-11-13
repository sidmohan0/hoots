import { db, now, uuid } from "./db.js";
import type { ToolDef } from "./model.js";

// v1 built-in talons (tools). Keyword recall + pin-to-pellet.
export function builtInTools(): ToolDef[] {
  return [
    {
      name: "recall",
      description: "Search the hoot's memory (its primary thread) for items matching a keyword query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "keywords to search for" },
        },
        required: ["query"],
      },
      execute: (args: { query: string }, ctx) => {
        const rows = db
          .prepare(
            `SELECT i.content, i.created_at FROM items i
             JOIN threads t ON t.id = i.thread_id
             WHERE t.hoot_id = ? AND i.kind = 'message'
               AND lower(i.content) LIKE '%' || lower(?) || '%'
             ORDER BY i.created_at DESC LIMIT 10`
          )
          .all(ctx.hootId, args.query);
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
