// Structured, line-oriented logger. Every line is one JSON object on stdout:
// { ts, level, msg, ...fields }. Fields go through `safe()` so a stray token or
// a whole request body can't bloat or leak a log line (DECISIONS.md #5: the
// ledger says what left the machine; logs say what happened inside it).
//
// PERCH_LOG_FILE mirrors the same lines into a file, rotated at 5 MB, keeping
// the last three files. A write failure never takes the daemon down.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED = 3;
const MAX_STRING = 200;
const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|cookie)/i;

function threshold(): number {
  const raw = (process.env.PERCH_LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[raw] ?? ORDER.info;
}

const logFile = process.env.PERCH_LOG_FILE ? path.resolve(process.env.PERCH_LOG_FILE) : null;
let fileBytes = 0;

function initFile() {
  if (!logFile) return;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    fileBytes = existsSync(logFile) ? statSync(logFile).size : 0;
  } catch {
    // An unwritable log path is a nuisance, not a boot failure.
  }
}
initFile();

/** Rotate before a write would cross the ceiling. 0 -> .1, .1 -> .2, .2 -> gone. */
function rotateIfNeeded(incoming: number) {
  if (!logFile || fileBytes + incoming <= MAX_LOG_BYTES) return;
  try {
    for (let i = KEEP_ROTATED; i >= 1; i--) {
      const dst = `${logFile}.${i}`;
      if (i === KEEP_ROTATED && existsSync(dst)) unlinkSync(dst);
      if (existsSync(`${logFile}.${i - 1}`) || i === 1) {
        if (existsSync(i === 1 ? logFile : `${logFile}.${i - 1}`)) renameSync(i === 1 ? logFile : `${logFile}.${i - 1}`, dst);
      }
    }
    fileBytes = 0;
  } catch {
    fileBytes = 0;
  }
}

function writeFile(line: string) {
  if (!logFile) return;
  const bytes = Buffer.byteLength(line);
  rotateIfNeeded(bytes);
  try {
    appendFileSync(logFile, line);
    fileBytes += bytes;
  } catch {
    // ignore
  }
}

/** Scrub one value: secrets blanked, long strings clipped, errors flattened. */
function safeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(safeValue);
  if (typeof value === "object") return safe(value as Record<string, unknown>);
  return String(value);
}

/** A copy of `fields` that is safe to print: secrets redacted, values clipped. */
export function safe(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY.test(key) ? (value ? "***" : value) : safeValue(value);
  }
  return out;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe(fields) })}\n`;
  process.stdout.write(line);
  writeFile(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
