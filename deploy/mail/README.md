# Self-hosted почтовый сервис (смежная услуга)

Опциональный почтовый сервер (`docker-mailserver`) под профилем compose `mail` в
[`deploy/compose/docker-compose.rf.yml`](../compose/docker-compose.rf.yml).
Полный план и стадии — [`docs/plan/mail-service-selfhosted.md`](../../docs/plan/mail-service-selfhosted.md).

Стадия **M1** — тест-мишень для edge email-драйверов: `edge-gateway` забирает почту
по IMAP и отправляет по SMTP на имя `mailserver` внутри docker-сети RF-кластера.

## Запуск (RF-кластер, профиль `mail`)

```bash
cp .env.rf.example .env.rf   # задайте MAIL_DOMAIN / MAIL_HOSTNAME
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml \
  --profile mail up -d mailserver
```

## Первичная инициализация: завести ящики

Аккаунты/конфиг персистятся в [`config/`](./config) (bind mount в
`/tmp/docker-mailserver/`).

```bash
DC="docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml"
# пароли не коммитить; для теста подойдут любые
$DC exec mailserver setup email add support@$MAIL_DOMAIN 'секрет-support'
$DC exec mailserver setup email add client@$MAIL_DOMAIN  'секрет-client'
$DC exec mailserver setup email list
```

## Проверка сквозного round-trip (M1)

Скрипт [`services/edge-gateway/scripts/verify-email-roundtrip.ts`](../../services/edge-gateway/scripts/verify-email-roundtrip.ts)
шлёт письмо через боевой nodemailer SMTP и забирает его боевым IMAP-клиентом
(`imapflow`) — те самые модули, что использует рантайм. Запуск из контейнера
`edge-gateway` (он в одной docker-сети с `mailserver`):

```bash
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml \
  exec \
    -e MAIL_HOST=mailserver \
    -e MAIL_SMTP_PORT=587 -e MAIL_IMAP_PORT=143 -e MAIL_IMAP_TLS=0 \
    -e MAIL_USER=support@$MAIL_DOMAIN -e MAIL_PASS='секрет-support' \
    -e MAIL_TO=client@$MAIL_DOMAIN \
    -e IMAP_USER=client@$MAIL_DOMAIN -e IMAP_PASS='секрет-client' \
    -e EMAIL_TLS_REJECT_UNAUTHORIZED=0 \
  edge-gateway node --import tsx scripts/verify-email-roundtrip.ts
```

Скрипт печатает `M1 VERIFY: PASS`, когда отправленное письмо появляется в ящике
получателя по IMAP.

> **Порты/TLS (M1).** Без `SSL_TYPE` docker-mailserver поднимает только
> STARTTLS-порты **587** (submission) и **143** (IMAP); implicit-TLS **993/465**
> появляются при `SSL_TYPE` (Этап M3). Поэтому в M1 проверка идёт по 143 c
> `MAIL_IMAP_TLS=0` (STARTTLS) и `EMAIL_TLS_REJECT_UNAUTHORIZED=0` (self-signed).

## Стадии M2–M5

Провижининг ящиков на организацию, DKIM/SPF/DMARC, deliverability, продуктивизация
— см. план. M1 намеренно без внешней доставки (внутри docker-сети, self-signed TLS).
