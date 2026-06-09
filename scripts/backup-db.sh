#!/bin/bash
set -e

APP_DIR="/opt/otp"
BACKUP_DIR="$APP_DIR/backups"
DATE=$(date +%Y-%m-%d_%H-%M)
FILE="$BACKUP_DIR/db_$DATE.sql.gz"

mkdir -p "$BACKUP_DIR"

# Load env
source "$APP_DIR/.env"

echo "→ Бекап бази даних..."
docker compose -f "$APP_DIR/docker-compose.prod.yml" exec -T db \
    pg_dump -U "${POSTGRES_USER:-dmuser}" "${POSTGRES_DB:-domainmanager}" \
    | gzip > "$FILE"

SIZE=$(du -sh "$FILE" | cut -f1)
echo "✅ Бекап збережено: $FILE ($SIZE)"

# Delete backups older than 30 days
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime +30 -delete
echo "→ Старі бекапи (>30 днів) видалено"
