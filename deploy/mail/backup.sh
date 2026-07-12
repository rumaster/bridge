#!/usr/bin/env bash
# Бэкап/восстановление self-hosted почтовика (Этап M4,
# docs/plan/mail-service-selfhosted.md). Запуск на хосте с docker.
#
# Бэкапит named-volumes с ящиками/состоянием и bind-конфиг (аккаунты, DKIM-ключи,
# квоты) в один архив. Восстановление — обратно (перезапустите mailserver после).
#
#   deploy/mail/backup.sh backup [--out <dir>]
#   deploy/mail/backup.sh restore <archive.tar.gz>
#
# Переменные (дефолты — под стенд):
#   MAIL_COMPOSE_PROJECT  проект compose (default bridge-edge-rf) → префикс volume
#   MAIL_DATA_VOLUME / MAIL_STATE_VOLUME  явные имена volume (перекрывают проект)
#   MAIL_CONFIG_DIR       каталог bind-конфига (default <этот каталог>/config)
#   MAIL_BACKUP_DIR       куда класть архивы (default /var/backups/bridge-mail)
#
# ВНИМАНИЕ: архив содержит СЕКРЕТЫ (хеши паролей ящиков, приватный DKIM-ключ) —
# храните защищённо, не коммитьте.
set -euo pipefail

PROJECT="${MAIL_COMPOSE_PROJECT:-bridge-edge-rf}"
DATA_VOL="${MAIL_DATA_VOLUME:-${PROJECT}_bridge-mail-data}"
STATE_VOL="${MAIL_STATE_VOLUME:-${PROJECT}_bridge-mail-state}"
CONFIG_DIR="${MAIL_CONFIG_DIR:-$(cd "$(dirname "$0")/config" && pwd)}"
OUT_DIR="${MAIL_BACKUP_DIR:-/var/backups/bridge-mail}"
HELPER_IMAGE="${MAIL_BACKUP_IMAGE:-busybox:1.36}"

# tar named-volume → архив на хосте (том монтируется read-only).
vol_tar() {
  docker run --rm -v "$1":/src:ro -v "$(dirname "$2")":/out "$HELPER_IMAGE" \
    tar czf "/out/$(basename "$2")" -C /src .
}
# восстановить named-volume из архива (полная замена содержимого тома).
vol_untar() {
  docker run --rm -v "$1":/dst -v "$(dirname "$2")":/in:ro "$HELPER_IMAGE" \
    sh -c "cd /dst && rm -rf ..?* .[!.]* * 2>/dev/null; tar xzf /in/$(basename "$2") -C /dst"
}

cmd_backup() {
  local ts work archive
  ts="$(date -u +%Y%m%d-%H%M%S)"
  work="$(mktemp -d)"
  vol_tar "$DATA_VOL" "$work/mail-data.tar.gz"
  vol_tar "$STATE_VOL" "$work/mail-state.tar.gz"
  tar czf "$work/mail-config.tar.gz" -C "$CONFIG_DIR" .
  mkdir -p "$OUT_DIR"
  archive="$OUT_DIR/mail-backup-$ts.tar.gz"
  tar czf "$archive" -C "$work" mail-data.tar.gz mail-state.tar.gz mail-config.tar.gz
  rm -rf "$work"
  echo "backup: $archive ($(du -h "$archive" | cut -f1))"
}

cmd_restore() {
  local archive="${1:-}" work
  [ -f "$archive" ] || { echo "restore: архив не найден: $archive" >&2; exit 1; }
  work="$(mktemp -d)"
  tar xzf "$archive" -C "$work"
  vol_untar "$DATA_VOL" "$work/mail-data.tar.gz"
  vol_untar "$STATE_VOL" "$work/mail-state.tar.gz"
  ( cd "${CONFIG_DIR:?}" && rm -rf ..?* .[!.]* ./* 2>/dev/null || true )
  tar xzf "$work/mail-config.tar.gz" -C "$CONFIG_DIR"
  rm -rf "$work"
  echo "restored from $archive"
  echo "перезапустите почтовик, чтобы применить: docker restart ${MAILSERVER_CONTAINER:-bridge-edge-rf-mailserver-1}"
}

case "${1:-}" in
  backup) shift; [ "${1:-}" = "--out" ] && OUT_DIR="${2:?}"; cmd_backup ;;
  restore) shift; cmd_restore "${1:-}" ;;
  *) echo "usage: backup.sh {backup [--out <dir>] | restore <archive.tar.gz>}"; exit 2 ;;
esac
