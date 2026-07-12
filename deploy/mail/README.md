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

## M2 — Провижининг ящиков (`scripts/mail-provision.ts`)

Программное управление ящиками почтовика и (опционально) авто-подключение
email-канала организации. Скрипт запускается там, где доступен `docker` и
контейнер почтовика.

```bash
# MAIL_DOMAIN и MAILSERVER_CONTAINER задаются через env (дефолты — под стенд)
node --import tsx scripts/mail-provision.ts add support            # создать support@$MAIL_DOMAIN (пароль сгенерируется)
node --import tsx scripts/mail-provision.ts add support --json     # + машинный вывод email_credentials
node --import tsx scripts/mail-provision.ts password support       # ротировать пароль
node --import tsx scripts/mail-provision.ts list
node --import tsx scripts/mail-provision.ts del support
node --import tsx scripts/mail-provision.ts quota support 512M
```

Соглашение об адресах: аргумент без `@` дополняется до `<localpart>@$MAIL_DOMAIN`.
Ящик-на-организацию — `--org <uuid>` (нужен и для авто-подключения канала).

**Авто-подключение канала** (опционально, требует сессии администратора — как и
ручное добавление на `:8081/channels`):

```bash
node --import tsx scripts/mail-provision.ts add support \
  --connect --backend http://backend:3000 \
  --org <organization-uuid> --token <session-token> --name "Email support"
```

Скрипт создаёт ящик, собирает `email_credentials` (IMAP/SMTP host/port/tls/логин/
пароль + from_email) и POST'ит `POST /api/v1/channels` — канал появляется как
`email/connected`, секрет хранится write-only (envelope AES-256-GCM), пароль
показывается один раз.

> **Запуск без Node на хосте.** Если на хосте нет Node, скрипт можно выполнить в
> одноразовом node-контейнере с проброшенным docker CLI и сокетом:
> ```bash
> docker run --rm \
>   -v /var/run/docker.sock:/var/run/docker.sock \
>   -v $(command -v docker):/usr/local/bin/docker \
>   -v "$PWD":/repo -w /repo \
>   -e MAIL_DOMAIN=$MAIL_DOMAIN -e MAILSERVER_CONTAINER=<container> \
>   node:20.20.2-bookworm-slim npx --yes tsx@4.19.2 scripts/mail-provision.ts <args>
> ```

## M3 — Deliverability (DNS/DKIM)

DKIM-ключ и DNS-записи (MX/SPF/DKIM/DMARC + PTR) — см.
[`dns-records.md`](./dns-records.md). Боевая доставка отложена (на стенде
исходящий порт 25 заблокирован, PTR некорректен) — детали и чек-лист там же.

## M4 — Эксплуатация

Скрипты запускаются на хосте с docker (Node не нужен).

**Бэкап/восстановление** ([`backup.sh`](./backup.sh)) — named-volumes (ящики,
состояние) + конфиг (аккаунты, DKIM, квоты) в один архив:

```bash
deploy/mail/backup.sh backup                 # → /var/backups/bridge-mail/mail-backup-<ts>.tar.gz
deploy/mail/backup.sh backup --out /srv/bk   # свой каталог
deploy/mail/backup.sh restore <archive>      # затем: docker restart <mailserver>
```
> Архив содержит секреты (хеши паролей, приватный DKIM) — храните защищённо.

**Мониторинг** ([`status.sh`](./status.sh)) — очередь Postfix, отказы доставки,
кол-во ящиков, заполнение диска, квоты; `exit 1` при превышении порогов (для cron):

```bash
deploy/mail/status.sh                                   # сводка + exit-код
MAIL_QUEUE_WARN=100 MAIL_DISK_WARN_PCT=90 deploy/mail/status.sh
# cron-алерт (пример): */10 * * * * deploy/mail/status.sh || mail-alert ...
# ежедневный бэкап:     15 3 * * *   deploy/mail/backup.sh backup
```

**Ротация логов** — `MAIL_LOGROTATE_INTERVAL` (daily|weekly|monthly, default weekly)
и `MAIL_LOGROTATE_COUNT` в `.env.rf` (применяется при пересоздании почтовика).

**Лимиты отправки (anti-abuse)** — шаблон
[`postfix-main.cf.example`](./postfix-main.cf.example): скопируйте в
`config/postfix-main.cf` и перезапустите почтовик. Базовые поклиентные anvil-лимиты;
точные per-user/per-org лимиты требуют policy-сервиса (postfwd) — отдельный шаг.

## M5 — Продуктивизация

Заказ ящика из админки, автопровижн, тариф — см. план.
