# AmneziaWG-туннель в боевых стеках (Этап 1, issue #257)

Этап 1 вписывает настоящий сетевой VPN-туннель AmneziaWG в **боевые** compose-файлы
Application Cluster и Edge Cluster РФ. C9-трафик `edge-gateway → edge-vpn-app`
идёт по **туннельным IP** внутри зашифрованного L3-туннеля (обход DPI — «случайный
UDP»). См. план [`docs/plan/vpn-amneziawg-tunnel.md`](../../docs/plan/vpn-amneziawg-tunnel.md).

## Архитектура

Awg-контейнер входит в **network namespace ноды** (`network_mode: "service:…"`),
а не наоборот — нода сохраняет свою идентичность/DNS/порты, а интерфейс `awg0`
появляется в её namespace:

```
App-кластер (docker-compose.yml)            Edge-кластер РФ (docker-compose.rf.yml)
┌───────────────────────────────┐          ┌───────────────────────────────┐
│ edge-vpn-app  (netns owner)   │          │ edge-gateway  (netns owner)   │
│   ├ awg0 10.7.0.1  ◀───────────┼──UDP/────┼─▶ awg0 10.7.0.2               │
│   └ C9 RPC :3049 на 10.7.0.1  │  obfs    │   └ EDGE_VPN_APP_TCP_URL=      │
│ awg-server (service:edge-vpn- │  51820   │       tcp://10.7.0.1:3049      │
│   app, cap NET_ADMIN, tun)    │          │ awg-client (service:edge-     │
└───────────────────────────────┘          │   gateway, cap NET_ADMIN, tun)│
   публичный UDP :51820 наружу              └───────────────────────────────┘
```

Оба awg-сервиса — под профилем compose **`tunnel`**: без него стеки поднимаются
как раньше (без туннеля), с ним — включается VPN.

## Быстрый старт (стенд, оба стека на одном хосте)

```bash
# 1. Скоординированные ключи/PSK/H1–H4 → .env.awg.app и .env.awg.rf (в .gitignore)
bash deploy/compose/awg-keygen.sh

# 2. App-сторона: awg-server + edge-vpn-app (с UDP-эндпоинтом)
docker compose --env-file .env --env-file deploy/compose/.env.awg.app \
  -f deploy/compose/docker-compose.yml --profile tunnel up -d --build edge-vpn-app awg-server

# 3. Edge-сторона: awg-client + edge-gateway (C9 → туннельный IP)
docker compose --env-file .env.rf --env-file deploy/compose/.env.awg.rf \
  -f deploy/compose/docker-compose.rf.yml --profile tunnel up -d --build edge-gateway awg-client
```

`awg-keygen.sh` по умолчанию ставит `AWG_ENDPOINT=host.docker.internal:51820`
(на стенде `edge-gateway` резолвит его в host-gateway через `extra_hosts`). В
проде задайте `AWG_ENDPOINT=<публичный DNS/IP App-кластера>:51820` перед шагом 1
(`AWG_ENDPOINT=… bash deploy/compose/awg-keygen.sh`).

## Проверка (DoD Этапа 1)

```bash
# Туннель поднят + healthcheck зелёный
docker compose … logs awg-server   # awg show: latest handshake, h1–h4
docker ps --filter name=awg-        # (healthy)

# Ping туннельного IP из namespace edge-gateway
docker exec bridge-edge-rf-awg-client-1 ping -c3 10.7.0.1

# C9 через туннель (проба Этапа 0 в namespace edge-gateway)
docker run --rm --network "container:bridge-edge-rf-edge-gateway-1" \
  -e EDGE_VPN_APP_TCP_URL=tcp://10.7.0.1:3049 \
  -e EDGE_VPN_SESSION_KEY=… -e EDGE_VPN_EDGE_CERT=… -e EDGE_VPN_TRUSTED_APP_CERTS=… \
  bridge-awg-poc-c9-probe node --import tsx deploy/compose/awg-poc/c9-probe.ts
```

## Прод-заметки

- Кластеры на **разных хостах**: `AWG_ENDPOINT` — публичный UDP App-кластера;
  общий docker-network и `host.docker.internal` не нужны.
- `S1/S2` и `H1–H4` **обязаны совпадать** на обеих сторонах (общий профиль
  обфускации); `Jc/Jmin/Jmax` — только на клиенте (сервер junk не шлёт).
- Хранение/ротация ключей и версионирование профиля обфускации — вынесенная
  задача (Q5/Q6), вне Этапа 1.
- Снятие прикладного криптослоя C9 и liveness по свежести хендшейка — **Этап 2**.
