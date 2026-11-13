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
`);

export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();
