// Schema migrations. One table, one rule: every migration runs exactly once,
// in id order, inside a transaction, and its id is recorded in
// `schema_migrations`. Contributors add an entry at the bottom — never edit or
// renumber a shipped one.
//
// Migrations stay idempotent anyway (CREATE TABLE IF NOT EXISTS, hasColumn
// guards) because databases created before this table existed come back with an
// empty ledger and replay 001..002 on first boot.
import type Database from "better-sqlite3";
import { logger } from "./log.js";

export type Migration = { id: string; up: (db: Database.Database) => void };

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

function addColumn(db: Database.Database, table: string, ddl: string, col: string) {
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export const MIGRATIONS: Migration[] = [
  {
    // 001 — surfaces on turns/items, plus the one-time FTS backfill for items
    // that predate the index. Was an ad-hoc block in db.ts.
    id: "001_surfaces_and_fts_backfill",
    up(db) {
      addColumn(db, "turns", "origin_surface TEXT NOT NULL DEFAULT 'web'", "origin_surface");
      addColumn(db, "items", "surface TEXT", "surface");
      addColumn(db, "items", "delivered TEXT NOT NULL DEFAULT ''", "delivered");

      db.prepare("DELETE FROM items_fts").run();
      db.prepare(
        `INSERT INTO items_fts (item_id, text)
         SELECT id,
                COALESCE(json_extract(content, '$.text'), '') || ' ' ||
                COALESCE(json_extract(content, '$.fact'), '')
         FROM items
         WHERE kind IN ('message','note') AND json_valid(content)`
      ).run();
    },
  },
  {
    // 002 — canonical facts, day digests, the outbound ledger, the composer
    // queue, per-surface read state, and the promise run log.
    id: "002_facts_digests_ledger_queue",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        hoot_id TEXT NOT NULL REFERENCES hoots(id),
        text TEXT NOT NULL,
        category TEXT,
        scope TEXT NOT NULL DEFAULT 'hoot',
        source_item_id TEXT,
        confidence TEXT NOT NULL DEFAULT 'extracted',
        created_at INTEGER NOT NULL,
        forgotten_at INTEGER
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS day_digests (
        hoot_id TEXT NOT NULL REFERENCES hoots(id),
        date TEXT NOT NULL,
        text TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        PRIMARY KEY (hoot_id, date)
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS outbound_log (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        dest TEXT NOT NULL,
        purpose TEXT NOT NULL,
        bytes INTEGER NOT NULL
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS queued_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        message TEXT NOT NULL,
        surface TEXT NOT NULL DEFAULT 'web',
        miss_note INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`);
      // Older databases predate the one-note-per-day flag.
      addColumn(db, "queued_turns", "miss_note INTEGER NOT NULL DEFAULT 0", "miss_note");

      db.exec(`CREATE TABLE IF NOT EXISTS read_state (
        hoot_id TEXT NOT NULL REFERENCES hoots(id),
        surface TEXT NOT NULL,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (hoot_id, surface)
      )`);

      // Every scheduler fire (and every promise that never got one) is logged
      // here so the drawer can show kept/late/missed history (DECISIONS.md #10).
      db.exec(`CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        hoot_id TEXT NOT NULL REFERENCES hoots(id),
        scheduled_at INTEGER NOT NULL,
        fired_at INTEGER,
        outcome TEXT NOT NULL CHECK (outcome IN ('sent','late','missed','skipped'))
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_hoot_day ON automation_runs(hoot_id, scheduled_at)`);
    },
  },
];

/** Create the ledger if absent. Cheap enough to run on every boot. */
export function ensureMigrationTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
}

/** Apply every pending migration in order. Returns the ids applied this run. */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): string[] {
  ensureMigrationTable(db);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id)
  );
  const done: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, Date.now());
    });
    tx();
    logger.info("migration applied", { id: migration.id });
    done.push(migration.id);
  }
  return done;
}
