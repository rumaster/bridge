#!/usr/bin/env bash
# Мониторинг self-hosted почтовика (Этап M4, docs/plan/mail-service-selfhosted.md).
# Печатает сводку здоровья; exit 1 при превышении порогов (для cron/алертов).
#
#   deploy/mail/status.sh
#
# Пороги/цель через env:
#   MAILSERVER_CONTAINER  контейнер почтовика (default bridge-edge-rf-mailserver-1)
#   MAIL_QUEUE_WARN       порог очереди Postfix (default 50)
#   MAIL_DISK_WARN_PCT    порог заполнения /var/mail в % (default 85)
set -uo pipefail

CONT="${MAILSERVER_CONTAINER:-bridge-edge-rf-mailserver-1}"
QUEUE_WARN="${MAIL_QUEUE_WARN:-50}"
DISK_WARN="${MAIL_DISK_WARN_PCT:-85}"

dexec() { docker exec "$CONT" sh -c "$1" 2>/dev/null; }

# Кол-во писем в очереди Postfix (строки-ID начинаются с hex; пустая очередь → 0).
queue="$(dexec "postqueue -p | grep -cE '^[0-9A-F]{6,}' || true")"
deferred="$(dexec "postqueue -p | grep -c 'deferred' || true")"
disk="$(dexec "df -P /var/mail | awk 'NR==2{gsub(/%/,\"\",\$5); print \$5}'")"
mailboxes="$(docker exec "$CONT" setup email list 2>/dev/null | grep -c '@' || true)"

echo "mailserver=$CONT"
echo "queue=${queue:-?} deferred=${deferred:-?} mailboxes=${mailboxes:-?} disk_used=${disk:-?}%"
echo "--- квоты ящиков ---"
docker exec "$CONT" doveadm quota get -A 2>/dev/null | head -12 || echo "(нет данных)"
echo "--- последние отказы доставки (mail.log) ---"
dexec "grep -aE 'status=(bounced|deferred)' /var/log/mail/mail.log 2>/dev/null | tail -5" || true

alert=0
if [ "${queue:-0}" -gt "$QUEUE_WARN" ] 2>/dev/null; then echo "ALERT: очередь $queue > $QUEUE_WARN"; alert=1; fi
if [ "${disk:-0}" -gt "$DISK_WARN" ] 2>/dev/null; then echo "ALERT: диск ${disk}% > ${DISK_WARN}%"; alert=1; fi
exit $alert
