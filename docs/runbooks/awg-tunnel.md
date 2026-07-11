# Runbook — AmneziaWG VPN Tunnel (issue #257)

Диагностика и восстановление туннеля Edge (РФ) ↔ App (за рубежом). Главная задача
runbook — **отличить DPI-блокировку от обычного сбоя**, т.к. лечение разное.

> Контекст: план [`vpn-amneziawg-tunnel.md`](../plan/vpn-amneziawg-tunnel.md),
> метрики/алерты [`deploy/observability`](../../deploy/observability/README.md).
> При недоступности туннеля Edge деградирует в буферизацию (RF-first, §7.9) — данные
> **не теряются**; runbook восстанавливает канал и дренаж.

## 1. Триггеры

- Алерт `AwgTunnelDown` / `AwgTunnelNeverHandshaked` / `AwgTunnelHandshakeStale`.
- `EdgeChannelDegraded` / `EdgeBufferBacklog` (растёт `edge_buffer_pending`).

## 2. Сбор сигналов

```bash
# Liveness и буфер со стороны Node:
curl -s edge-gateway:3000/metrics | grep -E 'edge_tunnel_liveness_up|edge_buffer_pending|edge_cluster_channel_down_total'

# Свежесть хендшейка / rx-tx (awg-экспортер, обе стороны):
curl -s edge-gateway:9586 | grep awg_peer_handshake_age_seconds
curl -s edge-vpn-app:9586 | grep awg_peer_handshake_age_seconds

# Состояние интерфейса в namespace awg-контейнера:
docker exec bridge-edge-rf-awg-client-1 awg show awg0
```

Ключевые величины:
- `edge_tunnel_liveness_up` — 0 = Edge не достаёт App через туннель.
- `awg_peer_handshake_age_seconds` — возраст хендшейка; `-1` = не было ни разу.
- `awg_peer_rx_bytes` — растёт ли приём (ответы App-стороны приходят?).

## 3. Дерево решений: DPI-блокировка vs обычный сбой

```
Хендшейк был хоть раз? (age != -1)
├─ ДА, но age большой и НЕ растёт rx  → был контакт, потом пропал:
│   ├─ App-сторона (awg-server/edge-vpn-app) жива? контейнер Up, :51820 слушает?
│   │   ├─ НЕТ  → ОБЫЧНЫЙ СБОЙ: App упал/перезапуск → §4.A
│   │   └─ ДА   → tx растёт, rx — нет (пакеты уходят, ответов нет):
│   │            подозрение на DPI/сетевую фильтрацию UDP → §4.D
│   └─ Оба живы, age снова падает после keepalive → транзиентный разрыв, само-
│       восстановление; следить за EdgeBufferBacklog → §4.E
└─ НЕТ (age == -1, хендшейк не состоялся ни разу):
    ├─ Конфиг совпадает на сторонах? (ключи, PSK, H1–H4, endpoint)
    │   ├─ НЕТ  → ОБЫЧНЫЙ СБОЙ: рассинхрон конфигурации → §4.B
    │   └─ ДА   → UDP-эндпоинт вообще доступен на IP-уровне?
    │            (другой UDP-порт/ICMP до App проходит, а :51820 — нет,
    │             tx растёт, rx = 0, стабильно)  → вероятна DPI-БЛОКИРОВКА → §4.D
    └─ DNS AWG_ENDPOINT резолвится? нет → ОБЫЧНЫЙ СБОЙ: DNS/endpoint → §4.C
```

**Эвристика DPI vs сбой:** обычный сбой обычно **симметричен и с явной причиной**
(контейнер down, неверный ключ, DNS-ошибка, весь трафик до хоста не идёт).
DPI-блокировка — **избирательна**: `tx` растёт, `rx` близок к нулю именно по
AWG-UDP-потоку, при том что IP-уровень/другие протоколы до App живы; часто
внезапное начало, привязка к региону/оператору, хендшейк «уходит в пустоту».

## 4. Действия по причинам

- **§4.A App упал/рестарт.** Поднять App-сторону: `docker compose … up -d
  edge-vpn-app awg-server`. Хендшейк и дренаж восстановятся автоматически
  (keepalive + supervisor). Проверить `edge_tunnel_liveness_up → 1`.
- **§4.B Рассинхрон конфигурации.** Сверить на обеих сторонах: публичные ключи
  пиров, `AWG_PRESHARED_KEY`, `AWG_H1..H4`, `AWG_S1/S2`, подсеть/AllowedIPs.
  H1–H4/S1/S2 **обязаны совпадать**. Перегенерировать пару
  `deploy/compose/awg-keygen.sh` и переподнять обе стороны.
- **§4.C DNS/endpoint.** Проверить резолв `AWG_ENDPOINT`; поправить DNS/значение.
  Supervisor пере-резолвит автоматически, но неверный хост не поднимется.
- **§4.D DPI-блокировка.** Сменить/усилить профиль обфускации: другой публичный
  UDP-порт (`AWG_LISTEN_PORT`/`AWG_ENDPOINT`), иные `Jc/Jmin/Jmax`, `S1/S2`,
  свежие `H1–H4`; при необходимости — сигнатурные пакеты `I1–I5` (AWG 2.0).
  Смена/резерв порта и версионирование профиля — задача MVP2 (Q3/Q5). До смены
  профиля Edge продолжает буферизировать — потери нет.
- **§4.E Транзиентный разрыв.** Ничего не делать, если само-восстановление
  проходит и `edge_buffer_pending` дренажируется. Иначе эскалировать как §4.D.

## 5. Проверка восстановления

```bash
curl -s edge-gateway:3000/metrics | grep -E 'edge_tunnel_liveness_up|edge_buffer_pending'
# liveness_up == 1, pending → 0 (буфер дренажируется без потерь/дублей/перестановок)
docker exec bridge-edge-rf-awg-client-1 awg show awg0 | grep 'latest handshake'
```

Порядок восстанавливает ядро по `sequence_number`, дедуп — по сквозному
`idempotency_key` (SVC-CORE). Потерь при разрыве нет — это подтверждено
сценарием CP-7 «Потеря соединения» (§26.6) поверх реального туннеля.
