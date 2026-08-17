#!/usr/bin/env bash
# Nightly online backup of the bot's SQLite DB. Safe to run against a LIVE db:
# uses SQLite's online-backup API via the sqlite3 CLI `.backup` command, so it
# never corrupts an in-flight write. Keeps the last $KEEP gzipped daily copies.
#
# Wired into deploy.sh as a systemd timer (kazzhol-backup.timer, nightly 03:30).
# Manual run:  sudo -u kazzhol bash /opt/kazzhol-ai/deploy/backup.sh
set -euo pipefail

APP_DIR="/opt/kazzhol-ai"
DB="${DB_PATH:-$APP_DIR/kazzhol.db}"
BACKUP_DIR="$APP_DIR/backups"
KEEP="${BACKUP_KEEP:-14}"

[ -f "$DB" ] || { echo "backup: db not found at $DB — nothing to do (first boot?)"; exit 0; }
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/kazzhol-$STAMP.db"

# .backup is the safe online-backup path (not a raw cp of a live file).
sqlite3 "$DB" ".backup '$DEST'"
gzip -f "$DEST"

# Rotate: keep the $KEEP newest, delete the rest.
ls -1t "$BACKUP_DIR"/kazzhol-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "backup ok: ${DEST}.gz (keeping newest $KEEP)"
