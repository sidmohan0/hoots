import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { runMigrations } from "./migrate.js";

mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS hoots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  model_base_url TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_params TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  hoot_id TEXT NOT NULL REFERENCES hoots(id),
  kind TEXT NOT NULL CHECK (kind IN ('bough','hunt')),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  goal TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_bough ON threads(hoot_id) WHERE kind='bough';

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','interrupted')),
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message','tool_call','tool_result','note')),
  role TEXT,
  content TEXT NOT NULL,        -- json
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_thread ON items(thread_id, created_at);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  hoot_id TEXT NOT NULL REFERENCES hoots(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  rrule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  thread_kind TEXT NOT NULL DEFAULT 'bough',
  deliver INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_fired_at INTEGER,
  next_fire_at INTEGER
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  hoot_id TEXT NOT NULL REFERENCES hoots(id),
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, external_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- FTS5 recall index over message/note items. Standalone (not external-content)
-- because the indexed text is extracted from the items.content JSON ($.text /
-- $.fact), which external-content tables can't express column-wise. Kept in
-- sync with triggers below; no lazy rebuild needed.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items
WHEN new.kind IN ('message','note') BEGIN
  INSERT INTO items_fts (item_id, text) VALUES (
    new.id,
    CASE WHEN json_valid(new.content)
      THEN COALESCE(json_extract(new.content, '$.text'), '') || ' ' ||
           COALESCE(json_extract(new.content, '$.fact'), '')
      ELSE '' END
  );
END;

CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE OF content, kind ON items
WHEN new.kind IN ('message','note') OR old.kind IN ('message','note') BEGIN
  DELETE FROM items_fts WHERE item_id = new.id;
  INSERT INTO items_fts (item_id, text)
  SELECT new.id,
         CASE WHEN json_valid(new.content)
           THEN COALESCE(json_extract(new.content, '$.text'), '') || ' ' ||
                COALESCE(json_extract(new.content, '$.fact'), '')
           ELSE '' END
  WHERE new.kind IN ('message','note');
END;
`);

export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as any;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// --- schema ----------------------------------------------------------------
// Baseline tables are created inline above (CREATE TABLE IF NOT EXISTS), so a
// fresh database is usable before migrations run. Everything after that is a
// numbered migration in migrate.ts, applied once and recorded.

// Legacy marker, kept so old tooling still sees a version. The real ledger is
// schema_migrations; bump this only for cosmetics.
if (getMeta("schema_version") === null) setMeta("schema_version", "2");

runMigrations(db);

// Fired more than 15 minutes after schedule = late, never "sent" (#10).
export const LATE_GRACE_MS = 15 * 60_000;

export type RunOutcome = "sent" | "late" | "missed" | "skipped";

/** At most one "sorry I'm late" note per hoot per local day (#10). */
export function claimMissNote(hootId: string, epochMs: number = Date.now()): boolean {
  const key = `missnote:${hootId}:${localDate(epochMs)}`;
  if (getMeta(key) !== null) return false;
  setMeta(key, String(epochMs));
  return true;
}

export function recordAutomationRun(r: {
  automationId: string;
  hootId: string;
  scheduledAt: number;
  firedAt: number | null;
  outcome: RunOutcome;
}): void {
  db.prepare(
    `INSERT INTO automation_runs (id, automation_id, hoot_id, scheduled_at, fired_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), r.automationId, r.hootId, r.scheduledAt, r.firedAt, r.outcome);
}

/** `YYYY-MM-DD` for an instant in the perch host's local zone. */
export function localDate(epochMs: number = Date.now()): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Epoch bounds of a local calendar day, [start, end). */
export function localDayBounds(date: string): { start: number; end: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { start: new Date(y, m - 1, d).getTime(), end: new Date(y, m - 1, d + 1).getTime() };
}

db.exec(`CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  hoot_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS computer_places (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  name TEXT NOT NULL,
  app TEXT,
  label TEXT,
  created_at INTEGER NOT NULL
)`);
