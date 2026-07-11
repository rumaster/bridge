---
title: Ручное e2e-тестирование канала Telegram через РФ-Edge (CP-2)
audience: QA / тестировщик
service_id: SVC-INT · SVC-API · SVC-EDGE · SVC-TGC
based_on: docs/plan/telegram-channel-production.md (этапы T0–T6)
date: 2026-07-10
---

# Runbook: разворачивание Edge-сервера «как в РФ» и полный цикл теста Telegram

Пошаговая инструкция для тестировщика: поднять **Application Cluster** и отдельный
**Edge Cluster (эмуляция сервера в РФ)**, соединить их VPN-туннелем и провести полный
боевой цикл канала Telegram: подключение бота организации → приём входящего клиента
**RF-first через Edge** → доставка менеджеру → ответ → доставка клиенту, с проверкой
идемпотентности и деградации.

> Всё делается на **одной машине** (Windows/macOS/Linux + Docker Desktop). Два
> кластера — это два независимых compose-проекта в разных docker-сетях; связь между
> ними идёт через `host.docker.internal` (хостовый шлюз Docker Desktop), что и
> эмулирует «отдельный сервер в РФ».

---

## 0. Что мы разворачиваем

```
                      ХОСТ (Docker Desktop)
┌───────────────────────────── Application Cluster (bridge-saas) ─────────────────────────────┐
│  postgres:5432   redis:6379                                                                  │
│  backend:3000  ── acceptIngress, C7 Redis Stream, egress → SVC-INT                            │
│  integration-platform:3005 ── getUpdates-поллер входящих (T3) + доставка per-org токеном (T2) │
│  saas-admin:8081   manager-workspace:8082   notification-platform:3010                        │
│  edge-vpn-app: TCP 3049 / WSS 3050 ── App-сторона VPN-туннеля → /internal/edge/tunnel/messages│
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ EDGE_INGRESS_URL                                   ▲ tcp://host.docker.internal:3049
        │ (SVC-INT → RF-edge)                                │ (RF-edge → App-VPN)
┌───────────────────────── Edge Cluster «РФ» (bridge-edge-rf) ─────────────────────────┐
│  postgres-rf:5433 ── edge_message_buffer (RF-буфер, шифртекст, sequence_number)       │
│  edge-gateway:3060 (EDGE_GATEWAY_MODE=edge) ── /internal/edge/ingress/messages        │
│      RF-first: шифрует, кладёт в буфер, форвардит через VPN-туннель в App-VPN         │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Поток входящего для клиента РФ:
`клиент → BOT-A (getUpdates) → SVC-INT → EDGE_INGRESS_URL → RF-буфер → VPN → App-VPN →
backend /internal/edge/tunnel/messages → acceptIngress → messages + C7`.

---

## 1. Предпосылки

- **Docker Desktop** (с `docker compose` v2).
- **Три Telegram-сущности:**
  1. **BOT-A — бот организации** (создать у [@BotFather](https://t.me/BotFather),
     `/newbot`, сохранить токен вида `123456:AA...`). На него будет писать «клиент».
     Он должен быть **выделенным** (не использоваться нигде для getUpdates/webhook).
  2. **Аккаунт-«клиент»** — ваш обычный Telegram-аккаунт, с которого вы напишете BOT-A.
  3. *(опционально, для UI-логина и G-8)* **BOT-B** — бот для кодов входа/консоли
     менеджера. Для основного цикла не обязателен (используем прямую сессию через API).
- **git-bash / PowerShell**, `curl`, и `node` (для генерации секрета сессии). `psql`
  использовать не нужно — ходим в БД через `docker compose exec`.
- Порты хоста свободны: `3000, 3005, 3010, 3049, 3050, 3060, 5432, 5433, 6379, 8081, 8082`.

> **Важно про getUpdates.** У BOT-A не должен быть установлен webhook и не должно быть
> второго потребителя getUpdates, иначе Telegram вернёт 409. Сбросьте webhook один раз:
> `curl "https://api.telegram.org/bot<BOT_A_TOKEN>/deleteWebhook"`

---

## 2. Генерация секретов

Сгенерируйте значения (git-bash / WSL):

```bash
openssl rand -hex 32       # CHANNEL_SECRET_ENCRYPTION_KEY (backend, 32 байта hex)
openssl rand -hex 32       # BRIDGE_AUTH_SECRET (хеш сессий)
openssl rand -base64 32    # EDGE_BUFFER_ENCRYPTION_KEY (RF-буфер, 32 байта)
openssl rand -base64 32    # EDGE_VPN_SESSION_KEY (общий для обоих кластеров!)
```

Нет openssl — используйте node:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # hex
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # base64
```

> `EDGE_VPN_SESSION_KEY` **обязан совпадать** в `.env` и `.env.rf` — это pre-shared
> секрет VPN-туннеля. Идентичности сторон (`EDGE_VPN_*_CERT`) в этом стенде — это
> строковые «отпечатки» app-level mTLS, а не реальные сертификаты; берём согласованные
> плейсхолдеры (см. ниже) — их достаточно для проверки, в проде замените на реальные.

---

## 3. Конфигурация окружения

### 3.1 `.env` — Application Cluster (в корне репозитория)

```bash
cp .env.example .env
```

Затем задайте/проверьте в `.env` следующие ключи (остальное можно оставить по умолчанию):

```dotenv
# --- секреты backend ---
BRIDGE_AUTH_SECRET=<hex-из-шага-2>
CHANNEL_SECRET_ENCRYPTION_KEY=<hex-из-шага-2>

# Бот для кодов входа/консоли (BOT-B). Для основного цикла можно оставить пустым.
TELEGRAM_BOT_TOKEN=

# --- Входящий Telegram + RF-first Edge (T3/T5) ---
TELEGRAM_INBOUND_ENABLED=true
# SVC-INT публикует входящее РФ-клиентов в РФ-edge (через хостовый шлюз Docker):
EDGE_INGRESS_URL=http://host.docker.internal:3060/internal/edge/ingress/messages

# --- App-сторона VPN-туннеля (общий секрет + согласованные «отпечатки») ---
EDGE_VPN_SESSION_KEY=<base64-VPN-из-шага-2>
EDGE_VPN_APP_ID=app-core
EDGE_VPN_APP_CERT=app-core-cert
EDGE_VPN_TRUSTED_EDGE_CERTS=edge-rf-cert
```

### 3.2 `.env.rf` — Edge Cluster «РФ» (в корне репозитория)

```bash
cp .env.rf.example .env.rf
```

Задайте в `.env.rf`:

```dotenv
EDGE_GATEWAY_MODE=edge
# Порт РФ-edge на хосте — 3060, чтобы не конфликтовать с backend:3000.
EDGE_GATEWAY_PORT=3060

EDGE_BUFFER_ENCRYPTION_KEY=<base64-буфер-из-шага-2>
# ТОТ ЖЕ секрет, что и в .env:
EDGE_VPN_SESSION_KEY=<base64-VPN-из-шага-2>

# Идентичность РФ-стороны и доверие к App-стороне (зеркально к .env):
EDGE_VPN_EDGE_ID=edge-rf
EDGE_VPN_EDGE_CERT=edge-rf-cert
EDGE_VPN_TRUSTED_APP_CERTS=app-core-cert

# App-сторона VPN из Application Cluster — через хостовый шлюз Docker:
EDGE_VPN_APP_TCP_URL=tcp://host.docker.internal:3049
EDGE_VPN_APP_WSS_URL=ws://host.docker.internal:3050/vpn
```

> Соответствие «отпечатков»: `.env.rf: EDGE_VPN_EDGE_CERT` == `.env: EDGE_VPN_TRUSTED_EDGE_CERTS`
> и `.env.rf: EDGE_VPN_TRUSTED_APP_CERTS` == `.env: EDGE_VPN_APP_CERT`.

---

## 4. Запуск Application Cluster

Из **корня репозитория**:

```bash
# 1) поднять инфраструктуру + сервисы (миграции применятся сервисом migrate)
docker compose --env-file .env -f deploy/compose/docker-compose.yml up --build -d

# 2) засеять демо-организацию и админа
docker compose --env-file .env -f deploy/compose/docker-compose.yml --profile seed up seed
```

Проверка готовности:

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml ps
curl -s http://localhost:3000/health          # backend → {"status":"ok"...}
curl -s http://localhost:3005/health          # integration-platform → ok
```

Ожидаемые ориентиры:
- Демо-организация: `00000000-0000-4000-8000-000000000101`
- Админ-пользователь: `00000000-0000-4000-8000-000000000201` (роль administrator)

Проверьте, что App-сторона VPN слушает:
```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml logs edge-vpn-app | grep "app-vpn listening"
# edge-gateway app-vpn listening on tcp://0.0.0.0:3049 and ws(s)://0.0.0.0:3050/vpn
```

---

## 5. Запуск Edge Cluster «РФ»

Из **корня репозитория** (отдельный проект, отдельный `--env-file`):

```bash
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml up --build -d
```

Проверка:

```bash
curl -s http://localhost:3060/health
# {"status":"ok","service":"edge-gateway","mode":"production-edge",...}
```

**Проверьте, что VPN-туннель РФ↔App поднялся** (в логах RF-edge не должно быть
циклических ошибок соединения):

```bash
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml logs edge-gateway | tail -30
```

Если видите повторяющиеся ошибки подключения к `host.docker.internal:3049`:
- убедитесь, что `edge-vpn-app` запущен и слушает (шаг 4);
- проверьте совпадение `EDGE_VPN_SESSION_KEY` и «отпечатков» в обоих env;
- на Linux (не Docker Desktop) `host.docker.internal` может не резолвиться — тогда
  добавьте RF-edge в сеть app-кластера или используйте IP хоста.

---

## 6. Получение сессии для API (без Telegram-логина)

Для подключения канала и проверок будем ходить в API с Bearer-токеном. Создадим
сессию сид-админу напрямую (быстрее, чем UI-логин через бота).

1) Вычислите хеш токена (секрет — ваш `BRIDGE_AUTH_SECRET`):

```bash
export BRIDGE_AUTH_SECRET='<ваш BRIDGE_AUTH_SECRET>'
export SESSION_TOKEN='qa-e2e-session'
node -e "const{createHmac}=require('crypto');console.log('sha256:'+createHmac('sha256',process.env.BRIDGE_AUTH_SECRET).update('auth_session:server:'+process.env.SESSION_TOKEN).digest('hex'))"
# → sha256:....  (скопируйте)
```

2) Вставьте сессию в БД App-кластера:

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml exec postgres \
  psql -U bridge -d bridge -c "SELECT set_config('app.is_platform_operator','true',false);
  INSERT INTO auth_sessions (id, user_id, organization_id, token_hash, issued_at, expires_at, revoked_at, ip, user_agent)
  VALUES (gen_random_uuid(),
          '00000000-0000-4000-8000-000000000201',
          '00000000-0000-4000-8000-000000000101',
          '<ХЕШ-из-п.1>',
          now(), now() + interval '30 days', NULL, '127.0.0.1'::inet, 'qa');"
```

3) Проверьте доступ:

```bash
curl -s http://localhost:3000/api/v1/channels \
  -H "authorization: Bearer qa-e2e-session" \
  -H "x-organization-id: 00000000-0000-4000-8000-000000000101"
# [] — пустой список каналов (сессия валидна)
```

> Хотите пройти UI-логином вместо этого: задайте `TELEGRAM_BOT_TOKEN` (BOT-B) в `.env`,
> обновите сид-админу `telegram_username`/`telegram_id` на **свой** аккаунт
> (`UPDATE users SET telegram_username='<ваш_ник>', telegram_id='<ваш_id>' WHERE id='00000000-0000-4000-8000-000000000201';`),
> напишите BOT-B `/start`, затем войдите на `http://localhost:8081`.

---

## 7. Подключение канала Telegram (T1) + пометка «РФ»

Подключаем BOT-A как канал организации и сразу помечаем канал как РФ
(`config.region="RF"`), чтобы входящее шло **через Edge**.

```bash
export ORG=00000000-0000-4000-8000-000000000101
export BOT_A='123456:AA...'   # токен BOT-A

curl -s -X POST http://localhost:3000/api/v1/channels \
  -H "authorization: Bearer qa-e2e-session" \
  -H "x-organization-id: $ORG" \
  -H "content-type: application/json" \
  -d "{\"organization_id\":\"$ORG\",\"channel_type\":\"telegram\",\"name\":\"RF Support Bot\",\"credentials\":\"$BOT_A\",\"config\":{\"region\":\"RF\"}}"
```

Ответ содержит `channel.id`, `channel.status:"connected"`, `channel.credentials_ref`
(секрет — только `secret://...`, самого токена в ответе нет). Сохраните `id`:

```bash
export CH=<channel.id из ответа>
```

**Реальный `:test` (getMe):**

```bash
curl -s -X POST "http://localhost:3000/api/v1/channels/$CH:test" \
  -H "authorization: Bearer qa-e2e-session" -H "x-organization-id: $ORG"
# {"accepted":true,"status":"connected", ...}  → getMe прошёл, config.bot_username/bot_id заполнены
```

Проверка, что токен зашифрован и канал помечен РФ:

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml exec postgres \
  psql -U bridge -d bridge -c "SELECT set_config('app.is_platform_operator','true',false);
  SELECT id, status, credentials_ref, config->>'region' AS region,
         (credentials_envelope IS NOT NULL) AS has_secret
  FROM channels WHERE channel_type='telegram';"
# status=connected | region=RF | has_secret=t
```

> SVC-INT обновляет реестр каналов раз в `TELEGRAM_INBOUND_REFRESH_INTERVAL_MS` (30 c).
> Подождите ~30 с после подключения — поллер getUpdates для BOT-A запустится
> автоматически (берутся только каналы `status='connected'`).

---

## 8. Полный цикл теста

### 8.1 Входящее RF-first: клиент пишет боту

1. В Telegram со своего аккаунта откройте **BOT-A**, нажмите **Start** и отправьте:
   `Здравствуйте, где мой заказ?`

2. **Проверьте RF-буфер (клиент РФ приземлился в РФ ДО ядра):**

```bash
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml exec postgres-rf \
  psql -U bridge_edge -d bridge_edge -c \
  "SELECT endpoint_id, sequence_number, idempotency_key, (forwarded_at IS NOT NULL) AS forwarded
   FROM edge_message_buffer ORDER BY received_at DESC LIMIT 5;"
# строка есть; forwarded=t после успешной пересылки в App
```

Метрики РФ-edge:
```bash
curl -s http://localhost:3060/metrics | grep -E "edge_ingested_total|fixed_in_rf_total|forwarded_total"
# ingested>=1, fixed_in_rf>=1, forwarded>=1
```

3. **Проверьте, что дошло до ядра (таблица `messages`, правильная организация):**

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml exec postgres \
  psql -U bridge -d bridge -c "SELECT set_config('app.is_platform_operator','true',false);
  SELECT organization_id, conversation_id, endpoint_id, channel, direction, sender_type, status, content->>'text' AS text
  FROM messages WHERE direction='inbound' ORDER BY created_at DESC LIMIT 5;"
# organization_id=...101 | channel=telegram | direction=inbound | sender_type=client | status=routed | text=Здравствуйте...
# запомните conversation_id и endpoint_id — понадобятся для ответа менеджера (§8.2 API-путь)
```

4. **Проверьте realtime-событие C7 (T4) в Redis Stream:**

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml exec redis \
  redis-cli XLEN bridge:c7:events
docker compose --env-file .env -f deploy/compose/docker-compose.yml exec redis \
  redis-cli XREVRANGE bridge:c7:events + - COUNT 3
# среди событий — type=message.created с вашим сообщением
```

### 8.2 Менеджер видит и отвечает

- **UI-путь (проверяет T4 live):** войдите в `http://localhost:8082` (manager-workspace)
  под менеджером организации (см. UI-логин в §6). Новый диалог/сообщение появляется в
  списке; если ваш стенд отдаёт C7-WS менеджеру — вживую, иначе после обновления
  страницы (авторитетный сигнал T4 — событие в Redis Stream из §8.1.4). Откройте
  диалог и отправьте ответ: `Ваш заказ уже в пути 🚚`.

- **API-путь (без UI):** возьмите `conversation_id` и `endpoint_id` входящего
  сообщения (добавьте их в SELECT из §8.1.3) и создайте ответ менеджера
  (`POST /api/v1/messages`; `direction`/`senderType` по умолчанию outbound/manager;
  роль administrator включает manager):

```bash
export CONV=<conversation_id>
export ENDPOINT=<endpoint_id>
curl -s -X POST "http://localhost:3000/api/v1/messages" \
  -H "authorization: Bearer qa-e2e-session" -H "x-organization-id: $ORG" \
  -H "content-type: application/json" \
  -d "{\"conversationId\":\"$CONV\",\"endpointId\":\"$ENDPOINT\",\"type\":\"text\",\"content\":{\"text\":\"Ваш заказ уже в пути\"}}"
```

### 8.3 Ответ доходит клиенту + статусы

1. В Telegram вы (как клиент) получаете от **BOT-A** сообщение «Ваш заказ уже в пути».
2. Доставка ушла **токеном этой организации** (T2). Проверьте попытку доставки:

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml exec postgres \
  psql -U bridge -d bridge -c "SELECT set_config('app.is_platform_operator','true',false);
  SELECT m.direction, m.status AS msg_status, a.adapter, a.attempt_no, a.status AS attempt_status
  FROM messages m LEFT JOIN message_delivery_attempts a ON a.message_id=m.id
  WHERE m.direction='outbound' ORDER BY m.created_at DESC LIMIT 5;"
# msg_status проходит routed→sent (→delivered), adapter=telegram, attempt_status=sent/delivered
```

### 8.4 Идемпотентность

- **Входящее:** в Telegram переслать/повторить нельзя точь-в-точь, но повтор апдейта
  эмулируется рестартом поллера — этого делать вручную не нужно; ключевой инвариант
  проверяется тем, что **число строк `inbound` в `messages` равно числу уникальных
  сообщений** (повтор апдейта даёт тот же UUID `message_id` и не двоит). Убедитесь,
  что на одно ваше сообщение — ровно одна строка.
- **Исходящее:** повторите тот же запрос ответа менеджера с тем же телом — второй раз
  внешнего `sendMessage` не будет (движок доставки идемпотентен по `idempotency_key`);
  клиент второй раз сообщение не получит.

### 8.5 Деградация: обрыв туннеля не теряет сообщения

1. «Роняем» App-сторону VPN (эмуляция обрыва Edge↔App):

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml stop edge-vpn-app
```

2. Со своего аккаунта отправьте BOT-A: `Сообщение при обрыве туннеля`.
3. Убедитесь, что оно **зафиксировано в РФ-буфере, но ещё не переслано** (RF-first, не
   потеряно):

```bash
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml exec postgres-rf \
  psql -U bridge_edge -d bridge_edge -c \
  "SELECT idempotency_key,(forwarded_at IS NOT NULL) AS forwarded FROM edge_message_buffer ORDER BY received_at DESC LIMIT 3;"
# новая строка: forwarded=f
curl -s http://localhost:3060/metrics | grep -E "buffered_offline_total|channel_down_total"
```

4. **Поднимаем туннель обратно и триггерим дренаж** (отправьте ещё одно сообщение
   BOT-A, чтобы edge инициировал авто-дренаж бэклога):

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml start edge-vpn-app
# подождите ~5–10 c переподключения (backoff), затем в Telegram отправьте BOT-A: "после восстановления"
```

5. Проверьте, что **отложенное досылается** и доходит до ядра:

```bash
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml exec postgres-rf \
  psql -U bridge_edge -d bridge_edge -c "SELECT COUNT(*) FROM edge_message_buffer WHERE forwarded_at IS NULL;"
# 0 — весь бэклог дренирован
docker compose --env-file .env -f deploy/compose/docker-compose.yml exec postgres \
  psql -U bridge -d bridge -c "SELECT set_config('app.is_platform_operator','true',false);
  SELECT content->>'text' FROM messages WHERE direction='inbound' ORDER BY created_at DESC LIMIT 3;"
# среди них — «Сообщение при обрыве туннеля» (не потеряно) и «после восстановления»
```

> Деградация Telegram API на исходящем (альтернативная проба): временно подставьте
> BOT-A недействительный токен через повторный `POST /channels` и отправьте ответ —
> доставка зафиксируется как `failed` в `message_delivery_attempts`, ядро не упадёт.

### 8.6 (Опционально) Проактивные карточки менеджеру (G-8)

Требует BOT-B (консоль менеджера). В `.env` задайте
`TELEGRAM_CONSOLE_BOT_TOKEN=<BOT_B>`, `TELEGRAM_CONSOLE_NOTIFICATIONS_PORT=3020`,
`SVC_TGC_NOTIFICATIONS_URL=http://telegram-console:3020`, поднимите профиль tools:

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.yml --profile tools up -d telegram-console
```

Менеджер пишет BOT-B `/start` (привязка сессии). При новом входящем SVC-NOTIF
форвардит карточку в консоль — менеджер получает её в чат с BOT-B.

---

## 9. Чек-лист приёмки (DoD CP-2)

| Проверка | Где смотреть | Ожидание |
|---|---|---|
| Канал подключён по реальному getMe | `POST /channels/{id}:test` | `status=connected`, `bot_username` заполнен |
| Токен зашифрован, наружу не отдан | `channels` | `credentials_envelope` не NULL, ответ без токена |
| Входящее РФ приземлилось RF-first | `edge_message_buffer` + `/metrics` edge | строка есть, `fixed_in_rf_total>=1` |
| Входящее дошло до ядра с верной org | `messages` (inbound) | `organization_id=...101`, `sender_type=client`, `status=routed` |
| Realtime-событие менеджеру | Redis `bridge:c7:events` | есть `message.created` |
| Ответ ушёл токеном этой организации | Telegram-клиент + `message_delivery_attempts` | клиент получил ответ, `adapter=telegram`, `sent/delivered` |
| Изоляция арендаторов | повторить §7–§8 для второй org/бота | входящие/исходящие не смешиваются |
| Идемпотентность | `messages` / `message_delivery_attempts` | нет дублей на повтор |
| Деградация без потерь | `edge_message_buffer.forwarded_at` | бэклог дренируется после reconnect |

---

## 10. Полезные команды и траблшутинг

```bash
# Логи ключевых сервисов
docker compose --env-file .env    -f deploy/compose/docker-compose.yml    logs -f integration-platform backend edge-vpn-app
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml logs -f edge-gateway

# Метрики доставки SVC-INT (исходящее)
curl -s http://localhost:3005/metrics | grep integration_platform_delivery_
```

Частые проблемы:
- **Входящее не приходит в ядро** → проверьте: у BOT-A нет webhook (`deleteWebhook`);
  прошло ≥30 c после подключения (рефреш реестра); `channel.status=connected`;
  токен корректен (`:test`). В логах `integration-platform` не должно быть 409 от getUpdates.
- **Входящее не идёт через Edge (сразу в ядро)** → `EDGE_INGRESS_URL` не задан в `.env`
  ИЛИ у канала нет `config.region="RF"` (проверьте §7). Пересоздайте сервис
  integration-platform после правки `.env`: `docker compose ... up -d integration-platform`.
- **RF-edge не форвардит (`forwarded=f` навсегда)** → VPN-туннель не поднят: сверьте
  `EDGE_VPN_SESSION_KEY` (идентичен в обоих env) и «отпечатки» сертификатов; проверьте
  логи `edge-gateway` и `edge-vpn-app`; убедитесь, что `host.docker.internal:3049`
  доступен из RF-контейнера.
- **401 на API** → истёкшая/неверная сессия: перегенерируйте хеш и вставьте заново (§6),
  токен в `Authorization: Bearer` должен совпадать с тем, из которого считали хеш.
- **`host.docker.internal` не резолвится (Linux без Docker Desktop)** → подключите RF-edge
  к сети app-кластера (`docker network connect bridge-saas_default bridge-edge-rf-edge-gateway-1`)
  и используйте имена сервисов, либо укажите IP хоста.

---

## 11. Остановка и очистка

```bash
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml down          # RF-edge
docker compose --env-file .env    -f deploy/compose/docker-compose.yml down             # App
# Полная очистка с данными (буфер РФ, БД, redis):
docker compose --env-file .env.rf -f deploy/compose/docker-compose.rf.yml down -v
docker compose --env-file .env    -f deploy/compose/docker-compose.yml down -v
```

---

## Приложение. Что подтверждает этот стенд относительно плана T0–T6

- **T1** — приём токена, шифрование, реальный getMe (§7).
- **T2** — исходящая доставка per-org токеном (§8.3).
- **T3** — входящий getUpdates-драйвер + маппинг bot→organization (§8.1).
- **T4** — C7 `message.created` на приёме (§8.1.4).
- **T5** — RF-first через Edge + деградация без потерь (§8.1.2, §8.5).
- **T6** — сквозной цикл, изоляция, идемпотентность, деградация (весь §8, §9).
- **G-8** — проактивные карточки менеджеру (§8.6, опционально).
