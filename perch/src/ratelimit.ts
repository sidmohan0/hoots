// Token bucket, one bucket per client key. Defence in depth: the perch is
// loopback-bound, but a runaway UI retry loop or a local script can still pin
// the daemon, and every POST can start a model turn.
//
// Key = client IP + path class ("/v1/hoots/:id/automations" -> "hoots/automations"),
// so hammering one family of routes does not starve another.
// PERCH_RATE_LIMIT is requests per minute (default 30, 0 disables).

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 30;

type Bucket = { tokens: number; updated: number };

const buckets = new Map<string, Bucket>();

export type Verdict = { ok: true } | { ok: false; retryAfter: number; limit: number };

/** Requests-per-minute ceiling from env. 0 (or negative) disables limiting. */
export function limitPerMinute(): number {
  const raw = process.env.PERCH_RATE_LIMIT;
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** Collapse `/v1/hoots/<uuid>/automations` to a stable class stem. */
export function pathClass(pathname: string): string {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .filter((s) => s !== "v1")
    .filter((s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) && !/^\d+$/.test(s));
  return segments.slice(0, 2).join("/") || "-";
}

export function clientKey(ip: string, pathname: string): string {
  return `${ip}|${pathClass(pathname)}`;
}

/** Charge one token. Buckets refill continuously at `limit/60s`. */
export function check(key: string, limit = limitPerMinute(), nowMs = Date.now()): Verdict {
  if (limit <= 0) return { ok: true };
  const refillPerMs = limit / WINDOW_MS;
  const bucket = buckets.get(key) ?? { tokens: limit, updated: nowMs };
  const refilled = Math.min(limit, bucket.tokens + (nowMs - bucket.updated) * refillPerMs);
  if (refilled < 1) {
    bucket.tokens = refilled;
    bucket.updated = nowMs;
    buckets.set(key, bucket);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - refilled) / refillPerMs / 1000)), limit };
  }
  bucket.tokens = refilled - 1;
  bucket.updated = nowMs;
  buckets.set(key, bucket);
  return { ok: true };
}

/** Drop buckets idle long enough to be full again (keeps the map bounded). */
export function sweep(nowMs = Date.now()): void {
  const limit = limitPerMinute();
  const refillPerMs = limit / WINDOW_MS;
  for (const [key, bucket] of buckets) {
    const fullAt = refillPerMs > 0 ? bucket.updated + (limit - bucket.tokens) / refillPerMs : nowMs;
    if (fullAt <= nowMs - WINDOW_MS) buckets.delete(key);
  }
}

/** Test seam. */
export function reset(): void {
  buckets.clear();
}
