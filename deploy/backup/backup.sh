#!/usr/bin/env bash
# Daily mongodump → R2 (S3 API via rclone). `backup.sh once` runs a single backup (restore drills, migration).
set -euo pipefail

: "${MONGODB_URI:?}"
: "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
BUCKET="${BACKUP_BUCKET:-backups}"
RETENTION="${BACKUP_RETENTION:-30d}"
AT="${BACKUP_AT:-03:30}"   # local time (TZ, default Asia/Seoul)
export TZ="${TZ:-Asia/Seoul}"

export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

run_backup() {
  local name="mongo/gamecollabs-$(date +%Y-%m-%dT%H%M).archive.gz"
  echo "$(date -Is) backup → r2:${BUCKET}/${name}"
  mongodump --uri="$MONGODB_URI" --archive --gzip | rclone rcat "r2:${BUCKET}/${name}"
  rclone delete --min-age "$RETENTION" "r2:${BUCKET}/mongo/"
  echo "$(date -Is) backup done"
}

if [[ "${1:-}" == "once" ]]; then
  run_backup
  exit 0
fi

while true; do
  now=$(date +%s)
  next=$(date -d "today ${AT}" +%s)
  (( next <= now )) && next=$(date -d "tomorrow ${AT}" +%s)
  sleep $(( next - now ))
  run_backup || echo "$(date -Is) backup FAILED" >&2
done
