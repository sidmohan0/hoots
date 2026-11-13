#!/bin/bash
# Consistent online backup of the perch ledger.
#
# `sqlite3 .backup` copies through the SQLite engine, so a running daemon with
# WAL writes cannot hand us a torn file. Output is gzipped into
# $PERCH_DATA_DIR/backups/perch-<ts>.db.gz and old copies are pruned to 14.
# Every failure exits non-zero — this is meant to be cron/launchd driven.
set -euo pipefail

DATA_DIR="${PERCH_DATA_DIR:-$HOME/.hoots}"
DB="${PERCH_DB_PATH:-$DATA_DIR/perch.db}"
BACKUP_DIR="$DATA_DIR/backups"
KEEP=14

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found on PATH" >&2
  exit 1
fi
if [ ! -f "$DB" ]; then
  echo "no database at $DB" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/perch-$TS.db.gz"

TMP="$(mktemp "${TMPDIR:-/tmp}/perch-backup.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# .backup needs a destination that does not exist yet.
if ! sqlite3 "$DB" ".backup '$TMP'"; then
  echo "sqlite .backup failed" >&2
  exit 1
fi

# Verify before compressing: a corrupt copy is worse than no copy.
INTEGRITY="$(sqlite3 "$TMP" "PRAGMA integrity_check;")"
if [ "$INTEGRITY" != "ok" ]; then
  echo "backup integrity_check failed: $INTEGRITY" >&2
  exit 1
fi

gzip -c "$TMP" > "$OUT"
if [ ! -s "$OUT" ]; then
  echo "empty backup written" >&2
  exit 1
fi

# Prune oldest first, keeping $KEEP files.
find "$BACKUP_DIR" -maxdepth 1 -name 'perch-*.db.gz' -type f | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

echo "$OUT"
