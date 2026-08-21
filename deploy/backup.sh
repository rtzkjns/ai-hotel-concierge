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

# --- Копия за пределы машины -------------------------------------------------
#
# Всё, что выше, лежит на ТОМ ЖЕ диске, что и сама база: потеря сервера уносит и базу,
# и все копии разом. Куда именно отправлять копию — решает владелец, поэтому шаг
# необязательный и включается заданием BACKUP_REMOTE в .env:
#
#   BACKUP_REMOTE=user@second-host:/backups/kazzhol     — по scp на другую машину
#   BACKUP_RCLONE=remote:kazzhol-backups                — в облако через rclone
#
# База содержит персональные данные гостей — имена, телефоны, почту и переписку.
# Поэтому наружу она уходит ТОЛЬКО зашифрованной, и без BACKUP_PASSPHRASE шаг не
# выполняется вовсе: незашифрованная выгрузка чужих данных хуже отсутствия копии.
# Сама парольная фраза на этом сервере бесполезна — храните её отдельно, иначе вместе
# с машиной потеряется и она.
REMOTE="${BACKUP_REMOTE:-}"
RCLONE="${BACKUP_RCLONE:-}"
PASS="${BACKUP_PASSPHRASE:-}"

if [ -n "$REMOTE$RCLONE" ]; then
  if [ -z "$PASS" ]; then
    echo "backup: BACKUP_REMOTE/BACKUP_RCLONE заданы, но BACKUP_PASSPHRASE пуста — выгрузка ПРОПУЩЕНА" >&2
  else
    ENC="${DEST}.gz.gpg"
    gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$PASS" -o "$ENC" "${DEST}.gz"
    if [ -n "$REMOTE" ]; then
      scp -q -o StrictHostKeyChecking=accept-new "$ENC" "$REMOTE/" \
        && echo "backup: копия ушла на $REMOTE" \
        || echo "backup: выгрузка на $REMOTE НЕ УДАЛАСЬ" >&2
    fi
    if [ -n "$RCLONE" ]; then
      rclone copy "$ENC" "$RCLONE" \
        && echo "backup: копия ушла в $RCLONE" \
        || echo "backup: выгрузка в $RCLONE НЕ УДАЛАСЬ" >&2
    fi
    rm -f "$ENC"
  fi
else
  echo "backup: внешнее хранилище не задано — копии лежат только на этой машине" >&2
fi

echo "backup ok: ${DEST}.gz (keeping newest $KEEP)"
