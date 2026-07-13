#!/usr/bin/env bash
# Suspend / unsuspend отправителя «Bridge Mail» по злоупотреблению (Этап M4,
# docs/plan/mail-service-selfhosted.md §M4). Управляет списком, который postfwd
# (postfwd.cf.example, правила SUSPEND_*) читает как file:-список и REJECT'ит.
#
#   deploy/mail/mail-suspend.sh add    client-<org>@<MAIL_DOMAIN>
#   deploy/mail/mail-suspend.sh del    client-<org>@<MAIL_DOMAIN>
#   deploy/mail/mail-suspend.sh list
#
# Значение — адрес ящика (sasl_username / sender). Для per-org suspend в модели
# «домен-на-организацию» добавьте все адреса организации (или используйте
# per-domain-правило postfwd).
#
# Env:
#   POSTFWD_SUSPEND_FILE  путь к списку (default deploy/mail/config/postfwd/suspended-senders.cf)
#   POSTFWD_CONTAINER     контейнер postfwd — при задании reload по SIGHUP после правки
set -uo pipefail

FILE="${POSTFWD_SUSPEND_FILE:-$(dirname "$0")/config/postfwd/suspended-senders.cf}"
CONT="${POSTFWD_CONTAINER:-}"

usage() { echo "usage: $0 {add|del|list} [sender]" >&2; exit 2; }

reload() {
  if [ -n "$CONT" ]; then
    if docker kill -s HUP "$CONT" >/dev/null 2>&1; then
      echo "postfwd ($CONT) перечитал списки (SIGHUP)"
    else
      echo "WARN: не удалось послать SIGHUP контейнеру $CONT — перезапустите postfwd вручную" >&2
    fi
  else
    echo "(POSTFWD_CONTAINER не задан — перезагрузите postfwd, чтобы список применился)"
  fi
}

cmd="${1:-}"; sender="${2:-}"
case "$cmd" in
  add)
    [ -n "$sender" ] || usage
    mkdir -p "$(dirname "$FILE")"; touch "$FILE"
    if grep -qxF "$sender" "$FILE"; then
      echo "уже приостановлен: $sender"
    else
      printf '%s\n' "$sender" >> "$FILE"
      # нормализуем: уникальные непустые строки
      sort -u -o "$FILE" "$FILE"
      echo "приостановлен: $sender"
      reload
    fi
    ;;
  del|delete|rm)
    [ -n "$sender" ] || usage
    [ -f "$FILE" ] || { echo "список пуст: $FILE"; exit 0; }
    if grep -qxF "$sender" "$FILE"; then
      # grep -v даёт exit 1, если после удаления файл пуст — это НЕ ошибка
      # (rc<=1 ок; rc>=2 — реальный сбой grep), иначе `&& mv` не сработал бы.
      grep -vxF "$sender" "$FILE" > "$FILE.tmp"; rc=$?
      if [ "$rc" -le 1 ]; then
        mv "$FILE.tmp" "$FILE"
        echo "снят suspend: $sender"
        reload
      else
        rm -f "$FILE.tmp"; echo "ошибка при правке $FILE" >&2; exit 1
      fi
    else
      echo "не найден в списке: $sender"
    fi
    ;;
  list|ls)
    if [ -s "$FILE" ]; then cat "$FILE"; else echo "(список пуст: $FILE)"; fi
    ;;
  *)
    usage
    ;;
esac
