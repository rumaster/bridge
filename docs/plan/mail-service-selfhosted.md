---
title: План создания собственного почтового сервиса (self-hosted mail) в Docker
service: Edge Gateway / RF Cluster / SaaS Administration
service_id: SVC-EDGE · SVC-MAIL (новый) · SVC-ADMIN
version: 1.0
status: Draft
language: ru-RU
based_on: docs/plan/email-channel-production.md, docs/plan/max-channel-production.md, deploy/compose/docker-compose.rf.yml
date: 2026-07-12
decisions:
  - "Поэтапно: сначала тест-мишень для сборщика (edge email-драйверов), затем продуктовая услуга «Bridge Mail» для клиентов без своей корпоративной почты."
  - "Размещение — RF/Edge cluster (deploy/compose/docker-compose.rf.yml), рядом с edge-gateway, под отдельным опциональным профилем `mail` (по умолчанию выключен)."
  - "Движок — docker-mailserver (single-image Postfix+Dovecot+Rspamd+OpenDKIM); Mailu/Mailcow рассматриваются как альтернатива только на продуктовой стадии, если понадобится web-админка/мультидомен."
  - "Почтовый домен (часть после @ в адресах ящиков) настраивается в .env отдельной переменной MAIL_DOMAIN; FQDN сервера MAIL_HOSTNAME задаётся самостоятельно (обычно mail.<MAIL_DOMAIN>), без вложенной подстановки ${..:-${..}} — она в compose ненадёжна."
---

# План создания собственного почтового сервиса (self-hosted mail) в Docker

Документ описывает, как добавить в проект **опциональный self-hosted почтовый
сервер** как смежную услугу, разворачиваемый в Docker под отдельным профилем.
Сервис решает две задачи, разнесённые по стадиям:

1. **Сейчас (тест-мишень).** Дать реальный IMAP/SMTP-эндпоинт в той же
   docker-сети, что и `edge-gateway`, чтобы «оживить» уже написанные, но пока
   работающие на инъектируемых клиентах email-драйверы Edge
   ([`edge-email-inbound-driver.ts`](../../services/edge-gateway/src/edge-email-inbound-driver.ts),
   [`edge-email-sender.ts`](../../services/edge-gateway/src/edge-email-sender.ts),
   [`edge-imap-mailbox.ts`](../../services/edge-gateway/src/edge-imap-mailbox.ts))
   на **настоящих сокетах**. Это прямой вклад в закрытие вехи **MP-12**
   (реальные IMAP IDLE/poll и nodemailer SMTP), обозначенной как единственный
   внешний блокер в [`email-channel-production.md`](./email-channel-production.md)
   (Этапы E3/E4).

2. **Позже (продуктовая услуга «Bridge Mail»).** Тот же сервис дорастает до
   выдачи почтовых ящиков бизнес-клиентам, у которых нет своей корпоративной
   почты: клиент получает ящик `client@mail.<наш-домен>`, а канал Email в
   Bridge подключается к нему теми же IMAP/SMTP-кредами, что и к внешнему
   провайдеру (форма на `:8081/channels`, Этап E1 email-плана). Никакой
   отдельной интеграции не требуется — с точки зрения `edge-gateway` это
   обычный IMAP/SMTP-хост.

> **Ограничение документа.** Только план: кода и диффов нет; оценки в
> человеко-днях не приводятся; шаги — логические/зависимостные единицы.
> Конкретные фрагменты `docker-compose` ниже — иллюстрация целевой структуры,
> а не готовый к `up` конфиг (реальные хосты/сертификаты/ключи DKIM
> генерируются при развёртывании).

---

## 0. Почему self-hosted и почему на RF/Edge-стороне

- **Согласованность с архитектурой канала Email.** По решению 1
  [`email-channel-production.md`](./email-channel-production.md) IMAP/SMTP
  физически исполняются на **Edge Gateway** (РФ-контур). Логично, чтобы и
  почтовый сервер, к которому Edge ходит по IMAP/SMTP, жил в том же периметре:
  трафик приёма/отправки не покидает RF-сторону, а на продуктовой стадии
  персональные данные писем клиентов резидентны (152-ФЗ), как и RF-буфер
  edge-сообщений (`postgres-rf`).
- **Тест без внешних провайдеров.** Регистрация ящиков у GMX/Yandex/Google
  упирается в капчу/телефон/OAuth2 (см. исследование ранее в этой сессии);
  self-hosted-мишень создаётся командой и не требует ни регистрации, ни
  выхода в интернет для юнит/интеграционных прогонов.
- **Единый образ вместо стороннего сервиса.** Смежная услуга остаётся внутри
  репозитория и его compose-контура (как `telegram-console` под профилем
  `tools`, `awg-*` под профилем `tunnel`), а не выносится во внешнюю
  инфраструктуру.

---

## 1. Выбор движка

| Движок | Состав | Плюсы | Минусы | Вердикт |
|--------|--------|-------|--------|---------|
| **docker-mailserver** | 1 образ: Postfix + Dovecot + Rspamd + OpenDKIM/Amavis, конфиг через env + volume | Минимальный футпринт, аудируемость, один сервис в compose, без внешней БД, легко перейти от теста к проду | Нет web-админки; аккаунты — через CLI-скрипт `setup` | ✅ **Выбор для стадий M1–M4** |
| **Mailu** | Набор образов (front/admin/imap/smtp/antispam/webmail) | Web-админка, мультидомен, API провижининга | Тяжелее (много контейнеров), больше поверхности | Кандидат на M5, если нужна web-админка/самообслуживание клиента |
| **Mailcow** | Крупный стек (~15 контейнеров) | Богатейшая админка, паритет с коммерцией | Ресурсоёмкий, тяжело встраивать в чужой compose | Не рекомендуется для встраивания |
| **GreenMail / smtp4dev** | In-memory тест-серверы | Мгновенно, для юнит-тестов | Не «настоящий» MTA, нет прод-пути | Параллельная опция только для CI (см. §6) |

**Обоснование:** для поэтапного пути «тест → прод» нужен один и тот же движок,
чтобы M1 не пришлось переписывать на M3. `docker-mailserver` даёт настоящий
Postfix/Dovecot (то есть реальный IMAP/SMTP уже на M1) и одновременно
масштабируется до продовой доставки (DKIM/SPF/DMARC/Rspamd) без смены
технологии. Общий вывод индустрии: **выбор MTA вторичен — 90% сложности прода
в deliverability (SPF/DKIM/DMARC/репутация IP)**, и это одинаково для всех трёх.

---

## 2. Целевая структура файлов

```
deploy/
  compose/
    docker-compose.rf.yml        # + сервис `mailserver` под профилем `mail`
  mail/                          # НОВОЕ — конфиг и состояние почтовика (в .gitignore, кроме примеров)
    mailserver.env.example       # ENABLE_RSPAMD/ONE_DIR/SSL_TYPE/... (пример)
    postfix-accounts.cf          # (генерируется CLI, не коммитится)
    opendkim/                    # (генерируется на M3, ключи DKIM — секреты)
    README.md                    # как поднять, как завести ящик, как выпустить DKIM
scripts/
  mail-provision.ts              # НОВОЕ (M2) — обёртка над `setup email add`, генерация кред,
                                 #            (опц.) запись в channels.credentials_envelope
.env.rf.example                  # + блок переменных MAIL_* (см. §4)
```

`docker-mailserver` не требует своего `Dockerfile` (используется upstream-образ
`ghcr.io/docker-mailserver/docker-mailserver`), поэтому в `deploy/docker/`
ничего не добавляется — только конфиг-каталог `deploy/mail/` и правка compose.

---

## 3. Фрагмент compose (профиль `mail` в docker-compose.rf.yml)

Добавляется в существующий `deploy/compose/docker-compose.rf.yml` (не в App
cluster). По умолчанию профиль **выключен** — RF-кластер поднимается как
раньше; `--profile mail` включает почтовик.

```yaml
  # Смежная услуга: self-hosted почтовый сервер (docs/plan/mail-service-selfhosted.md).
  # Профиль `mail` — опционально. M1: тест-мишень для edge email-драйверов;
  # M3+: боевая почта клиентов (DKIM/SPF/DMARC настраиваются при развёртывании).
  mailserver:
    profiles: ["mail"]
    image: ghcr.io/docker-mailserver/docker-mailserver:${MAIL_IMAGE_TAG:-latest}
    # FQDN самого сервера. Домен ящиков (MAIL_DOMAIN, часть после @) — отдельная
    # переменная; hostname задаётся самостоятельным значением (обычно
    # mail.<MAIL_DOMAIN>), а не через вложенную подстановку — см. шапку
    # docker-compose.yml про ненадёжность ${VAR:-${OTHER}}.
    hostname: ${MAIL_HOSTNAME:-mail.bridge.local}
    restart: unless-stopped
    environment:
      # M1 (тест): антиспам/антивирус выключены для скорости; TLS — self-signed
      # или none внутри docker-сети. M3 включает ENABLE_RSPAMD/OpenDKIM и SSL_TYPE=letsencrypt.
      ENABLE_RSPAMD: ${MAIL_ENABLE_RSPAMD:-0}
      ENABLE_CLAMAV: ${MAIL_ENABLE_CLAMAV:-0}
      ENABLE_OPENDKIM: ${MAIL_ENABLE_OPENDKIM:-0}
      ENABLE_FAIL2BAN: ${MAIL_ENABLE_FAIL2BAN:-0}
      SSL_TYPE: ${MAIL_SSL_TYPE:-}          # '' (M1) → 'letsencrypt' (M3)
      PERMIT_DOCKER: ${MAIL_PERMIT_DOCKER:-connected-networks}  # приём SMTP от edge-gateway в docker-сети
      ONE_DIR: 1
      # postmaster на настраиваемом домене (см. .env: MAIL_DOMAIN → MAIL_POSTMASTER).
      POSTMASTER_ADDRESS: ${MAIL_POSTMASTER:-postmaster@bridge.local}
      LOG_LEVEL: ${MAIL_LOG_LEVEL:-info}
    # M1: порты наружу НЕ публикуются — edge-gateway ходит по имени сервиса
    # (mailserver:993 / mailserver:587) внутри docker-сети RF-кластера.
    # M3 (прод): раскомментировать публикацию 25/465/587/993 и PTR/A-запись.
    # ports:
    #   - "25:25"    # входящий MX
    #   - "465:465"  # submissions (implicit TLS)
    #   - "587:587"  # submission (STARTTLS)
    #   - "993:993"  # IMAPS
    volumes:
      - bridge-mail-data:/var/mail
      - bridge-mail-state:/var/mail-state
      - bridge-mail-logs:/var/log/mail
      - ../mail/opendkim:/tmp/docker-mailserver/opendkim   # M3: ключи DKIM
    cap_add: [NET_ADMIN, SYS_PTRACE]      # для fail2ban/rspamd на M3; на M1 не критично
    healthcheck:
      test: ["CMD", "ss", "-lntp", "|", "grep", ":993"]
      interval: 10s
      timeout: 3s
      retries: 10

# volumes: (добавить к существующему блоку)
#   bridge-mail-data:
#   bridge-mail-state:
#   bridge-mail-logs:
```

**Подключение сборщика к мишени (M1):** в `.env.rf` для боевого запуска
edge-драйверов достаточно, чтобы administrator завёл на `:8081/channels`
email-канал с кредами `imap.host=mailserver`, `imap.port=993`,
`smtp.host=mailserver`, `smtp.port=587` (внутренние имена docker-сети) — и
control-plane синхронизирует их на Edge (Этап E2 email-плана). Отдельных
env-флагов на стороне edge-gateway не требуется — он уже умеет ходить по
структурным IMAP/SMTP-кредам.

---

## 4. Переменные окружения (.env.rf.example)

Добавляется блок (все — с дефолтами, профиль по умолчанию выключен, поэтому на
обычный RF-запуск не влияет):

```
# --- Смежная услуга: self-hosted почта (профиль `mail`, docs/plan/mail-service-selfhosted.md) ---
MAIL_IMAGE_TAG=latest
# Почтовый домен ящиков (часть после @). M1: любой, напр. bridge.local;
# M3: реальный домен с MX/SPF/DKIM/DMARC. Из него строятся адреса ящиков
# (mail-provision, §5.M2), MAIL_HOSTNAME и MAIL_POSTMASTER.
MAIL_DOMAIN=bridge.local
# FQDN сервера. Обычно mail.<MAIL_DOMAIN>; задаётся отдельным значением
# (не ${..:-mail.${MAIL_DOMAIN}} — вложенная подстановка в compose ненадёжна).
# M3: должен иметь A/PTR/MX-записи.
MAIL_HOSTNAME=mail.bridge.local
# Адрес postmaster; держите на MAIL_DOMAIN (postmaster@<MAIL_DOMAIN>).
MAIL_POSTMASTER=postmaster@bridge.local
MAIL_ENABLE_RSPAMD=0                      # M3: 1
MAIL_ENABLE_CLAMAV=0
MAIL_ENABLE_OPENDKIM=0                    # M3: 1
MAIL_ENABLE_FAIL2BAN=0                    # M3: 1
MAIL_SSL_TYPE=                            # M3: letsencrypt
MAIL_PERMIT_DOCKER=connected-networks
MAIL_LOG_LEVEL=info
```

---

## 5. Стадии

Зависимости внутри стадии не критичны, между стадиями — логический порядок.

> **Актуализация 2026-07-13 (проверка моков/разрывов).** M1–M5 реализованы, но
> сквозной email-путь на стенде работает **только через ручной скрипт**
> `verify-full-path.ts` (он играет роль App-стороны и синхронизирует креды на
> Edge). В штатной работе backend **не публикует** `channel_credentials_sync`,
> поэтому Edge видит `channels: 0` (лог edge-gateway), входящий IMAP ничего не
> поллит, а `egress_dispatch` падает с «No SMTP credentials». Это единственный
> оставшийся рантайм-разрыв email-канала; план закрытия —
> [`email-inbound-edge-implementation.md`](./email-inbound-edge-implementation.md).

### M1 — Тест-мишень: реальные IMAP/SMTP на настоящих сокетах — ✅ РЕАЛИЗОВАН

Закрывает практическую часть **MP-12** для email (E3/E4 «осталось» из
email-плана): подключить реальные сетевые клиенты вместо инъектируемых и
прогнать против живого сервера.

> **Статус: реализовано и развёрнуто на тест-стенде** (домен
> `lissac-games.online`). Что сделано:
> - Сервис `mailserver` (docker-mailserver) под профилем `mail` в
>   [`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml) +
>   volumes + блок `MAIL_*`/`EMAIL_*` в
>   [`.env.rf.example`](../../.env.rf.example); конфиг-каталог
>   [`deploy/mail/`](../../deploy/mail) (README + gitignore секретов).
> - Боевой SMTP-транспорт: `nodemailer`-фабрика
>   [`edge-smtp-transport.ts`](../../services/edge-gateway/src/edge-smtp-transport.ts)
>   за сеамом `createTransport` (ленивый импорт, TLS `rejectUnauthorized` под
>   self-signed M1). Реальный IMAP-клиент (`imapflow`) уже был в
>   [`edge-imap-mailbox.ts`](../../services/edge-gateway/src/edge-imap-mailbox.ts)
>   — добавлен проброс `tlsRejectUnauthorized`.
> - Wiring email в рантайм: `createEdgeChannelRuntime`
>   ([`edge-channel-drivers.ts`](../../services/edge-gateway/src/edge-channel-drivers.ts))
>   поднимает `EdgeEmailSender` (инжектится в control-plane для `egress_dispatch`)
>   и `EdgeEmailInboundDriver` (IMAP poll → RF-first `cluster.ingest`) рядом с MAX.
> - Dockerfile edge-gateway ставит `imapflow`/`mailparser`/`nodemailer`
>   (email-модули статически импортируются рантаймом).
> - Verify-скрипт
>   [`verify-email-roundtrip.ts`](../../services/edge-gateway/scripts/verify-email-roundtrip.ts):
>   реальный SMTP-send → реальный IMAP-fetch тех же модулей.
> - Тесты: `edge-smtp-transport.test.ts` (маппинг/секьюр/ленивость/e2e с сендером);
>   полный прогон edge-gateway зелёный (147 тестов).
> - **Сквозная проверка на стенде пройдена (`M1 VERIFY: PASS`):** nodemailer SMTP
>   отправил `support@` → `client@lissac-games.online`, imapflow забрал письмо
>   (uid/тема/message_id совпали). Нюанс: без `SSL_TYPE` docker-mailserver
>   поднимает только STARTTLS-порты 143(IMAP)/587(submission) — implicit-TLS
>   993/465 включаются на M3 вместе с `SSL_TYPE`. Проверка идёт по 143+STARTTLS,
>   `EMAIL_TLS_REJECT_UNAUTHORIZED=0` (self-signed внутри docker-сети).

- Добавить сервис `mailserver` под профилем `mail` в `docker-compose.rf.yml`
  (§3) + volumes + блок `MAIL_*` в `.env.rf.example` (§4).
- Скрипт/инструкция первичной инициализации: завести 1–2 тест-ящика на
  настраиваемом домене (`setup email add client@${MAIL_DOMAIN} <pass>`,
  `setup email add org@${MAIL_DOMAIN} <pass>`) — задокументировать в
  `deploy/mail/README.md`.
- Реализовать **реальный IMAP-клиент** (`createMailbox` поверх боевой
  IMAP-библиотеки, IDLE или poll) в
  [`edge-imap-mailbox.ts`](../../services/edge-gateway/src/edge-imap-mailbox.ts)
  и **реальный nodemailer SMTP-транспорт** (`createTransport`) в
  [`edge-email-sender.ts`](../../services/edge-gateway/src/edge-email-sender.ts)
  вместо инъектируемых в тестах — уже описано как остаток E3/E4.
- Прогнать существующий сквозной сценарий
  [`email-channel-e2e.test.ts`](../../services/edge-gateway/test/integration/email-channel-e2e.test.ts)
  **против реального `mailserver`** (в CI — как отдельный integration-профиль,
  поднимающий контейнер), а не против in-process заглушки: письмо реально
  забирается по IMAP, ответ реально уходит по SMTP, threading (`In-Reply-To`)
  сохраняется.

**DoD (M1):** `docker compose --env-file .env.rf -f docker-compose.rf.yml
--profile mail up` поднимает почтовик; edge-gateway реально забирает письмо из
ящика `mailserver:993` и реально отправляет ответ через `mailserver:587`;
e2e-сценарий email проходит на настоящих сокетах внутри docker-сети, без выхода
в интернет.

### M2 — Провижининг ящиков и связка с каналом Email — ✅ РЕАЛИЗОВАН

Делает почтовик управляемым из процесса Bridge, но ещё без внешней доставки.

> **Статус: реализовано и проверено на стенде.** Что сделано:
> - [`scripts/mail-provision.ts`](../../scripts/mail-provision.ts) — CLI-обёртка
>   над `setup` внутри контейнера почтовика: `add`/`password`(rotate)/`del`/
>   `list`/`quota`. Генерация строгого пароля, адрес без `@` дополняется
>   `MAIL_DOMAIN`, вывод `email_credentials` (human/`--json`).
> - Опциональный `--connect` → `POST /api/v1/channels` (сессия администратора,
>   как ручное добавление): собирает `email_credentials` (E0/E1) и подключает
>   канал; секрет — write-only (envelope AES-256-GCM).
> - Проверено на стенде (`lissac-games.online`): `add`→`list`→`password`
>   (новый пароль проходит `doveadm auth`, старый — нет)→`del`; `--connect`
>   создал канал `email/connected` с `credentials_envelope`. Инструкция и запуск
>   без Node на хосте (одноразовый node-контейнер) — в
>   [`deploy/mail/README.md`](../../deploy/mail/README.md).
> - Соглашение об адресах: общий `MAIL_DOMAIN` + локальная часть/`--org`;
>   мультидомен (домен-на-организацию) остаётся опцией M3/M5 (провижининг
>   `setup config domain`).

- `scripts/mail-provision.ts` — обёртка над CLI `docker-mailserver` (`setup
  email add/del/update`, квоты) для программного создания ящика на организацию.
- Соглашение об адресах поверх `MAIL_DOMAIN`: `client-<orgId>@${MAIL_DOMAIN}`
  (общий домен) либо поддомен/домен-на-организацию (мультидомен; тогда
  `MAIL_DOMAIN` — базовый, а домены организаций добавляются провижинингом) —
  решается на M2, влияет на M3-DNS.
- (Опционально) автозапись выданных кред в канал: `mail-provision` создаёт ящик
  и вызывает `POST /v1/channels` (email-креды, Этап E0/E1 email-плана), чтобы
  administrator не вводил их вручную. Пароль генерируется, шифруется существующим
  envelope-механизмом
  ([`channel-secret.store.ts`](../../services/backend/src/common/secrets/channel-secret.store.ts)),
  наружу не отдаётся (write-only).

**DoD (M2):** одной командой создаётся ящик организации и (опц.) сразу
подключённый email-канал; удаление/ротация — тем же скриптом.

### M3 — Deliverability и боевая доставка в интернет — 🟡 ПОДГОТОВЛЕНО (relay-модель реализована) / боевая доставка отложена

Превращает мишень в реальный MTA. **Это основная сложность продукта.**

> **Статус: relay-модель отправки реализована в конфиге; боевая доставка отложена
> из-за внешних блокеров.** Что сделано:
>
> **Модель отправки — решение и реализация.** Выбран **relay через транзакционный
> SMTP (587/465)** как ОСНОВНАЯ модель (не полный self-hosted MTA), т.к. исходящий
> порт 25 на площадке закрыт (§7.1/§7.3). Наш Postfix принимает письмо от клиента,
> **подписывает DKIM локально** и релеит наружу через провайдера с хорошей
> репутацией IP; порт 25 для исходящего не нужен. Реализовано конфигом:
> - `RELAY_HOST/PORT/USER/PASSWORD` в сервисе `mailserver`
>   ([`docker-compose.rf.yml`](../../deploy/compose/docker-compose.rf.yml)) +
>   блок `MAIL_RELAY_*` в [`.env.rf.example`](../../.env.rf.example). **Пустой
>   `MAIL_RELAY_HOST` (дефолт) = relay выключен, прямая доставка по MX — M1/M2-контур
>   не меняется.** Полный MTA остаётся возможным (пустой relay + открытый 25 + PTR).
> - Внутренняя M1-доставка (тот же локальный домен) идёт локально, минуя `relayhost`
>   (Postfix релеит только нелокальных адресатов) — включение relay безопасно.
> - Setup-инструкция relay + продовых тумблеров — [`deploy/mail/README.md`](../../deploy/mail/README.md) §M3.
>
> **DKIM/SPF/DMARC alignment.**
> - **DKIM-ключ сгенерирован** (`setup config dkim`, selector `mail`, RSA-2048);
>   приватная часть — `deploy/mail/config/opendkim/keys/lissac-games.online/`
>   (не коммитится), публичная — в [`deploy/mail/dns-records.md`](../../deploy/mail/dns-records.md).
> - OpenDKIM (`ENABLE_OPENDKIM=1`) подписывает как milter **до передачи в relay**,
>   поэтому **DMARC проходит по DKIM-alignment независимо от IP/SPF relay-хоста** —
>   это ключ к deliverability при relay. SPF-alignment опционален (нужен `include:`
>   relay-провайдера и наш envelope-домен) — разобрано в `dns-records.md` §alignment.
> - **DNS-записи подготовлены** (MX/A/SPF/DKIM/DMARC + relay-вариант SPF + PTR) —
>   [`deploy/mail/dns-records.md`](../../deploy/mail/dns-records.md), готовы к публикации.
> - Продовые тумблеры (`ENABLE_RSPAMD/OPENDKIM/OPENDMARC/FAIL2BAN`, `SSL_TYPE`)
>   сознательно НЕ включены на стенде по умолчанию (общий ресурс) — значения задокументированы.
>
> **Внешние блокеры боевой доставки на этом стенде (вне контроля кода):**
> 1. исходящий **порт 25 заблокирован** → покрывается relay-моделью выше при
>    наличии **relay-кред** транзакционного провайдера (их заводит владелец инфры);
> 2. **PTR = `bridge.`** (не FQDN) → чинится у провайдера IP; для relay-исхода не
>    на пути доставки, критичен только для входящего MX/прямой отправки;
> 3. домен `lissac-games.online` указывает на другой хост, MX/SPF/DMARC отсутствуют
>    → записи публикует владелец DNS-зоны;
> 4. TLS-сертификат (`SSL_TYPE=letsencrypt`) и публикация портов входящего MX.
>
> **Возобновление боевой доставки:** получить relay-креды (ИЛИ открытый 25 + PTR),
> заполнить `MAIL_RELAY_*`, включить тумблеры, опубликовать DNS — чек-лист
> «Что ещё нужно» в [`dns-records.md`](../../deploy/mail/dns-records.md).
>
> **Проверка на стенде 2026-07-13 (внутренний контур + DKIM):**
> - Канал `email` в БД (`channels.id=0e2702e3…`, `support@lissac-games.online`) —
>   расшифрован envelope (AES-256-GCM), пароль **валиден** (`doveadm auth test` →
>   `auth succeeded`); годится и для IMAP(143), и для submission(587).
> - Провижининг ящиков **работает**: `setup email add`/`update`/`del -y` (создание
>   и смена пароля на throwaway-ящике — новый пароль аутентифицируется). Нюанс:
>   старый пароль при немедленном ретесте ещё проходил — вероятно auth-cache Dovecot.
> - **DKIM-подпись подтверждена end-to-end:** при `MAIL_ENABLE_OPENDKIM=1`
>   реальная отправка `support@`→`client@` через submission-587 (AUTH LOGIN →
>   `queued`) даёт в доставленном письме валидный заголовок
>   `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/simple; d=lissac-games.online; s=mail`
>   (milter `$dkim_milter` на `smtpd`+`non_smtpd`). После проверки стенд возвращён
>   в baseline (`OPENDKIM=0`), тестовое письмо удалено.
> - **Внешняя доставка по-прежнему невозможна** без relay-кред: submission-587 без
>   `SSL_TYPE` — plaintext (STARTTLS не анонсируется), исходящий 25 закрыт; edge-gateway
>   видит `channels: 0` (backend не публикует `channel_credentials_sync` в штатном режиме).

- **Исходящий транспорт (основное):** relay через транзакционный SMTP —
  `MAIL_RELAY_HOST/PORT/USER/PASSWORD` в `.env.rf` (реализовано). Требует внешних
  relay-кред. Альтернатива — публикация портов 25/465/587/993 + открытый исходящий
  25 + статический IP c **PTR** (reverse DNS) = `MAIL_HOSTNAME` (полный MTA).
- DNS-записи домена: **MX** → `MAIL_HOSTNAME`; **A/AAAA**; **SPF** (`v=spf1 mx
  -all`, при relay с нашим envelope — `+include:` провайдера); **DKIM**
  (`setup config dkim`, публичная часть — в DNS TXT); **DMARC**
  (`v=DMARC1; p=quarantine; rua=...`). Оформлены в
  [`deploy/mail/dns-records.md`](../../deploy/mail/dns-records.md).
- Включить `ENABLE_RSPAMD=1`, `ENABLE_OPENDKIM=1`, `ENABLE_OPENDMARC=1`,
  `ENABLE_FAIL2BAN=1`, `SSL_TYPE=letsencrypt` (или проброс своих TLS-сертификатов).
- Проверка на mail-tester.com / Google Postmaster Tools, контроль spam-листов;
  при relay через провайдера прогрев IP на нашей стороне не требуется (репутацию
  держит relay).

**DoD (M3):** письмо, отправленное клиентом с боевого ящика Bridge, доходит во
внешние сервисы (Gmail/Yandex) в «Входящие», а не в спам; SPF/DKIM/DMARC
проходят (`dmarc=pass`).

### M4 — Эксплуатация — ✅ РЕАЛИЗОВАН

> **Статус: реализовано и проверено на стенде.** Что сделано:
> - **Бэкап/восстановление** — [`deploy/mail/backup.sh`](../../deploy/mail/backup.sh):
>   named-volumes (`bridge-mail-data`/`bridge-mail-state`) + bind-конфиг (аккаунты,
>   DKIM, квоты) в один архив; `restore <archive>`. Проверено: архив создаётся
>   (data/state/config, включая opendkim-ключи).
> - **Мониторинг** — [`deploy/mail/status.sh`](../../deploy/mail/status.sh):
>   очередь Postfix, `deferred`, кол-во ящиков, заполнение `/var/mail`, квоты
>   (`doveadm quota`), последние отказы доставки; `exit 1` при превышении порогов
>   (`MAIL_QUEUE_WARN`/`MAIL_DISK_WARN_PCT`) — для cron/алертов. Проверено на стенде.
> - **Ротация логов** — `MAIL_LOGROTATE_INTERVAL`/`MAIL_LOGROTATE_COUNT` в compose
>   (docker-mailserver `LOGROTATE_*`).
> - **Лимиты отправки (anti-abuse)** — шаблон
>   [`deploy/mail/postfix-main.cf.example`](../../deploy/mail/postfix-main.cf.example)
>   (поклиентные anvil-лимиты + размер письма); точные per-user/per-org лимиты
>   (postfwd) и suspend по злоупотреблению — отдельный шаг (услуга без боевой
>   исходящей доставки, M3 отложен).

- Бэкап volume `bridge-mail-data` (ящики) и `bridge-mail-state`; регламент
  восстановления.
- Мониторинг: очередь Postfix, отказы доставки, рост хранилища, метрики Rspamd;
  (опц.) экспортер в Prometheus рядом с уже используемыми метриками
  `edge-cluster`/awg.
- Ротация логов (`bridge-mail-logs`), алерты на переполнение диска и на попадание
  в блок-листы.
- Anti-abuse: лимиты отправки на ящик/организацию (чтобы услуга не стала
  спам-релеем), suspend по злоупотреблению.

**DoD (M4):** есть бэкап/restore-процедура, базовый мониторинг очереди и
хранилища, лимиты отправки на ящик.

### M5 — Продуктивизация «Bridge Mail» как услуги — ✅ РЕАЛИЗОВАН (базовый заказ)

> **Статус: реализовано и проверено на стенде** (базовый заказ ящика из админки;
> тариф/биллинг — по потребности). Что сделано:
> - **Провижининг-агент** — `serve`-режим
>   [`scripts/mail-provision.ts`](../../scripts/mail-provision.ts): HTTP
>   (`POST /provision`, `DELETE`, `GET /health`, Bearer-токен) рядом с почтовиком.
> - **Backend** — `IntegrationGatewayFacade.provisionManagedMailbox` +
>   `POST /api/v1/mail/mailboxes` (admin-auth,
>   [`mail.controller.ts`](../../services/backend/src/modules/integration-gateway/mail.controller.ts)):
>   зовёт агента → `connectChannel` (секрет write-only). Config `MAIL_PROVISION_URL`/
>   `MAIL_PROVISION_TOKEN`.
> - **saas-admin** — форма «Bridge Mail — заказать ящик» на `:8081/channels`
>   ([`ChannelsPage.tsx`](../../apps/saas-admin/src/presentation/pages/ChannelsPage.tsx))
>   + `api.channels.orderMailbox` + типы + MSW + vitest.
> - Проверено на стенде: `POST /api/v1/mail/mailboxes {local_part}` → HTTP 201,
>   ящик создан на почтовике, канал `email/connected` с `credentials_envelope`.
> - **Осталось (по потребности):** тариф/биллинг-хук, отображение квоты/адреса и
>   удаление ящика из UI, суспенд по злоупотреблению; агент как compose-сервис
>   (сейчас — `docker run`, рецепт в [`deploy/mail/README.md`](../../deploy/mail/README.md)).

- UI в SaaS Administration (`:8081`): заказ ящика организацией, отображение
  квоты/адреса; автопровижн через `mail-provision` (M2).
- Тариф/биллинг-хук (если услуга платная).
- Если понадобится web-почта/самообслуживание/мультидомен-админка — оценить
  миграцию движка на **Mailu** (набор образов с admin/API/webmail) как
  замену `docker-mailserver` на этой стадии; IMAP/SMTP-контракт для
  edge-gateway при этом не меняется.

**DoD (M5):** клиент заказывает ящик из админки, он автоматически создаётся и
подключается как канал Email без ручного ввода кред.

---

## 6. Альтернатива для CI-юнит-тестов (параллельно, не вместо)

Для быстрых юнит/интеграционных прогонов, где не нужен полноценный MTA, оставить
возможность поднимать **GreenMail** (встраиваемый SMTP+IMAP+POP3) или
**smtp4dev** контейнером — это не заменяет `mailserver`, а покрывает уровень,
где важна скорость, а не реалистичность доставки. Реальный `docker-mailserver`
(профиль `mail`) используется в интеграционном e2e (M1) и как боевой сервис
(M3+).

---

## 7. Риски и открытые вопросы

1. **Deliverability — главный риск продукта.** Свой MTA без прогретого IP и
   корректных SPF/DKIM/DMARC почти гарантированно попадает в спам крупных
   провайдеров. **РЕШЕНО (2026-07-13):** на входе в M3 выбран **relay исходящей
   почты через транзакционный SMTP** (свой Postfix принимает от клиента,
   подписывает DKIM локально, пересылает через внешний relay с хорошей репутацией),
   а не полный self-hosted MTA — исходящий порт 25 на площадке закрыт (§7.3), и
   relay снимает и его, и вопрос прогрева IP/репутации. Реализовано конфигом
   (`MAIL_RELAY_*`, §5.M3); полный MTA остаётся резервным вариантом при открытом 25.
2. **152-ФЗ и размещение.** Продуктовые ящики клиентов РФ должны храниться
   резидентно — согласуется с размещением в RF-кластере, но требует, чтобы
   volume `bridge-mail-data` был на RF-сервере (не на app-стороне).
3. **Порт 25 и провайдеры.** Многие хостинги/облака блокируют исходящий 25 —
   влияет на выбор «полный MTA vs relay» (п.1) и на площадку RF-сервера.
4. **Соглашение об адресах/доменах** (M2): один общий домен `MAIL_DOMAIN` с
   ящиками на организацию, или поддомен/домен на организацию (мультидомен) —
   влияет на объём DNS-настройки в M3. Для мультидомена `MAIL_DOMAIN` — базовый
   домен по умолчанию, а домены организаций регистрируются провижинингом
   (`setup config domain`), поэтому одной env-переменной на прод-стадии может
   быть недостаточно — это осознанная граница M2/M5.
5. **Хранение вложений.** Согласуется с открытым вопросом email-плана (§4.3):
   почтовик хранит письма целиком у себя (Dovecot maildir), тогда как канал
   Email нормализует вложения в `storage_ref` — на M1 источник вложений для
   `storage_ref` можно брать прямо из письма на IMAP.

---

## 8. Что осознанно вне плана

- Реальный TCP/TLS-сокет VPN-туннеля Edge↔App (веха MP-12/MP-22) — общий блокер
  RF-контура, не специфичен для почтовика; этот план даёт **локальную
  IMAP/SMTP-мишень**, но не решает вопрос межсерверного сокета туннеля.
- Полноценная миграция на Mailu/Mailcow — только гипотеза M5, не обязательство.
- Веб-интерфейс почты (webmail) для конечных пользователей ящиков — вне MVP
  услуги (менеджеры работают в manager-workspace, не в webmail).
- Интеграция с внешним KMS/Vault для ключей DKIM — вне MVP; ключи живут в
  `deploy/mail/opendkim` на RF-сервере, как и прочие RF-секреты до появления
  секрет-менеджера.
