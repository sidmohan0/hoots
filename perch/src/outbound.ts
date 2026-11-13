// The one outbound client. Every request that leaves the machine is logged
// here (DECISIONS.md #5): destination, purpose, bytes. A destination with no
// ledger row is a bug.
import { db, now, uuid } from "./db.js";

export function logOutbound(dest: "model" | "telegram" | "imessage" | "webhook", purpose: string, bytes: number) {
  db.prepare(
    `INSERT INTO outbound_log (id, ts, dest, purpose, bytes) VALUES (?, ?, ?, ?, ?)`
  ).run(uuid(), now(), dest, purpose, bytes);
}

export function outboundToday(): { count: number; bytes: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM outbound_log WHERE ts >= ?`)
    .get(start.getTime()) as any;
  return { count: row.n, bytes: row.b };
}
