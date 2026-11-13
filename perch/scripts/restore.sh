#!/bin/bash
# Restore the perch ledger from a backup made by backup.sh.
#
# Order matters: verify the archive, snapshot the current database out of the
# way, only then swap. The daemon keeps running, so restart it afterwards —
# the script prints the exact launchctl line.
#
#   perch/scripts/restore.sh ~/.hoots/backups/perch-20261113T090000Z.db.gz
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <backup.db.gz>" >&2
  exit 1
fi

ARCHIVE="$1"
DATA_DIR="${PERCH_DATA_DIR:-$HOME/.hoots}"
DB="${PERCH_DB_PATH:-$DATA_DIR/perch.db}"

if [ ! -f "$ARCHIVE" ]; then
  echo "no such backup: $ARCHIVE" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found on PATH" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/perch-restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

gzip -dc "$ARCHIVE" > "$WORK/restore.db"

INTEGRITY="$(sqlite3 "$WORK/restore.db" "PRAGMA integrity_check;")"
if [ "$INTEGRITY" != "ok" ]; then
  echo "integrity_check failed on $ARCHIVE: $INTEGRITY" >&2
  exit 1
fi
echo "integrity_check: ok"

mkdir -p "$DATA_DIR"

# Never clobber the live ledger without keeping a way back.
if [ -f "$DB" ]; then
  SAFETY="$DB.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  sqlite3 "$DB" ".backup '$SAFETY'"
  echo "current database saved: $SAFETY"
fi

# Stale WAL/SHM belong to the old database and must not be replayed over the new one.
rm -f "$DB-wal" "$DB-shm"
cp "$WORK/restore.db" "$DB"
echo "restored: $ARCHIVE -> $DB"

cat <<EOF

Restart the daemon to pick it up:
  launchctl kickstart -k gui/$(id -u)/com.hoots.perch

(dev instance instead: pkill -f "tsx src/index.ts" && npm run dev -w perch)
EOF
