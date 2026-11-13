#!/bin/bash
# Install (or refresh) the perch launchd agent. Idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST_SRC="$REPO_ROOT/perch/launchd/com.hoots.perch.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.hoots.perch.plist"
DATA_DIR="${PERCH_DATA_DIR:-$HOME/.hoots}"

# Build the compiled dist so `npm run start` runs real JS, not tsx.
(cd "$REPO_ROOT" && npm run build -w perch)

mkdir -p "$DATA_DIR" "$HOME/Library/LaunchAgents"

# Substitute paths (repo root + data dir) into the plist.
sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" -e "s|__DATA_DIR__|$DATA_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DST"

# Stop any dev instance that would fight the agent for port 7420.
pkill -f "tsx src/index.ts" 2>/dev/null || true

# Idempotent (re)load.
launchctl bootout gui/$(id -u)/com.hoots.perch 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST_DST"

sleep 2
if launchctl print gui/$(id -u)/com.hoots.perch | grep -q "state = running"; then
  echo "perch launchd agent: running (logs in $DATA_DIR/perch.log)"
else
  echo "perch launchd agent installed; check $DATA_DIR/perch.err.log if not running"
fi
