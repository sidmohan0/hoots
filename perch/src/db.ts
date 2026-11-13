import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

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

// --- migrations (run at import time; safe to re-run) ------------------------

// Schema version marker. Bump when a new migration is added; each migration
// gates its own work on its own meta flag so re-running is a no-op.
if (getMeta("schema_version") === null) setMeta("schema_version", "2");

// One-time FTS backfill for items that predate the index. Atomic with the
// flag write, so a crash mid-backfill re-runs it cleanly on next boot.
if (getMeta("fts_backfilled") === null) {
  db.transaction(() => {
    db.prepare("DELETE FROM items_fts").run();
    db.prepare(
      `INSERT INTO items_fts (item_id, text)
       SELECT id,
              COALESCE(json_extract(content, '$.text'), '') || ' ' ||
              COALESCE(json_extract(content, '$.fact'), '')
       FROM items
       WHERE kind IN ('message','note') AND json_valid(content)`
    ).run();
    setMeta("fts_backfilled", String(now()));
  })();
}
