// The one outbound client. Every request that leaves the machine is logged
// here (DECISIONS.md #5): destination, purpose, bytes. A destination with no
// ledger row is a bug.
import { createHmac } from "node:crypto";
import { db, getMeta, now, uuid } from "./db.js";
import { logger } from "./log.js";

const WEBHOOK_TIMEOUT_MS = 5000;
const SIGNATURE_HEADER = "x-hoots-signature";

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

// --- webhooks ---------------------------------------------------------------

/** Signature over the exact bytes we send: `sha256=<hex>`, HMAC-SHA256. */
export function signWebhook(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * POST JSON to a webhook URL, 5s timeout. Best-effort: resolves false on any
 * failure instead of throwing, so a caller can fire-and-forget.
 */
export async function sendWebhook(
  url: string | null,
  payload: Record<string, unknown>,
  purpose = "webhook"
): Promise<boolean> {
  if (!url) return false;
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "hoots-perch",
  };
  const secret = process.env.HOOTS_WEBHOOK_SECRET;
  if (secret) headers[SIGNATURE_HEADER] = signWebhook(body, secret);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    logOutbound("webhook", purpose, bytes);
    if (!res.ok) logger.warn("webhook non-2xx", { url, status: res.status, purpose });
    return res.ok;
  } catch (err) {
    // The request still left the machine (or tried to): keep the ledger honest.
    logOutbound("webhook", purpose, bytes);
    logger.warn("webhook failed", { url, purpose, error: err });
    return false;
  }
}

/**
 * Fire the configured webhook for an event. Never awaited by a turn, never
 * throws; a missing or blank url is a no-op.
 */
export function notifyWebhook(payload: Record<string, unknown>, purpose = "webhook"): void {
  const url = getMeta("webhook_url");
  if (!url) return;
  void sendWebhook(url, payload, purpose);
}
