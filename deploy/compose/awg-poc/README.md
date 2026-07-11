# PoC Этапа 0 — настоящий сетевой VPN на AmneziaWG (issue #257)

Реализует **Этап 0** из
[`docs/plan/vpn-amneziawg-tunnel.md`](../../../docs/plan/vpn-amneziawg-tunnel.md) §8:
поднимает два `amneziawg-go` (`awg-client` ↔ `awg-server`) в `docker-compose` и
прогоняет **C9 текущим кодом** (`vpn-transport.ts` + `vpn-tunnel.ts`) через
**туннельные IP** — то есть внутри зашифрованного L3-туннеля AmneziaWG.

## Что доказывает PoC (DoD Этапа 0)

- **C9 идёт внутри туннеля.** `c9-probe` (Edge) обращается к `c9-app` (App) по
  `tcp://10.7.0.1:3049` — туннельному IP App-стороны. Node-контейнеры делят
  network namespace с awg-контейнерами (`network_mode: service:awg-*`), поэтому
  трафик к `10.7.0.1` физически идёт по интерфейсу `awg0`.
- **DPI-профиль — случайный UDP.** Наружу (в compose-сети) виден только
  обфусцированный UDP `awg-client ↔ awg-server:51820`; проверяется `dpi-profile.sh`.
- **Кадр 2 МБ проходит без залипаний (Q8).** Проба шлёт «большой» C9-кадр
  (`C9_PROBE_CONTENT_BYTES`, по умолчанию ~1.3 МБ content → RPC-кадр ~1.85 МБ под
  лимитом 2 МБ), с фиксированным `MTU=1380`.
- **Работает на `ubuntu-latest` (Q7).** Отдельный **capability-gated** CI-job
  `awg-poc`; при отсутствии `/dev/net/tun` — SKIP, а не падение.

> Этап 0 намеренно **не** снимает прикладной криптослой (это Этап 2, Q2) и **не**
> трогает `edge-gateway`/БД. Цель — снять сетевую неопределённость (TUN, MTU,
> 2 МБ, обфускация), а не собрать прод-топологию.

## Запуск

Нужен Docker с доступом к `/dev/net/tun` (Linux-хост или CI `ubuntu-latest`; на
Docker Desktop/WSL2 TUN может быть недоступен).

```bash
# из корня репозитория
bash deploy/compose/awg-poc/run-poc.sh
```

Скрипт: проверяет capability → генерирует `.env.awg-poc` (ключи `awg genkey` +
PSK, Q6) → `docker compose up --build --exit-code-from c9-probe`. **Exit 0** =
DoD закрыт (или SKIP на окружении без TUN).

Проверить DPI-профиль вручную при поднятом стенде:

```bash
bash deploy/compose/awg-poc/dpi-profile.sh 15
```

## Файлы

| Файл | Назначение |
|---|---|
| `docker-compose.awg-poc.yml` | Стенд: `awg-server`+`c9-app`, `awg-client`+`c9-probe` |
| `../../docker/awg/Dockerfile` | Образ AmneziaWG (`amneziawg-go` + `amneziawg-tools`, MIT) |
| `../../docker/awg/entrypoint.sh` | Рендер `awg0.conf` из `AWG_*` + `awg-quick up` (Q6, вариант A) |
| `../../docker/awg/healthcheck.sh` | Liveness по свежести хендшейка (Q10) |
| `../../docker/awg-c9-probe/Dockerfile` | Node+tsx образ для прогона C9 текущим кодом |
| `c9-app.ts` / `c9-probe.ts` | App-терминатор и Edge-проба C9 (RPC-плоскость Q4) |
| `gen-keys.sh` | Одноразовые ключи/PSK/H1–H4 → `.env.awg-poc` (в `.gitignore`) |
| `check-capability.sh` | Gate `/dev/net/tun` + docker (Q7) |
| `dpi-profile.sh` | Проверка «случайный UDP» (tcpdump) |

## Параметры (`.env.awg-poc`)

Полный список — в [`.env.awg-poc.example`](./.env.awg-poc.example). Ключевое:
`AWG_MTU` (Q8), `AWG_JC/JMIN/JMAX/S1/S2` (обфускация клиента), `AWG_H1..H4`
(общий профиль обеих сторон), `AWG_*_PRIVATE_KEY/PUBLIC_KEY/PRESHARED_KEY`,
`C9_PROBE_CONTENT_BYTES`.

## Известные ограничения PoC

- Источники AmneziaWG собираются из `master` (`AWG_GO_REF`/`AWG_TOOLS_REF`
  позволяют пин конкретного тега для воспроизводимости).
- MSS clamping (`AWG_CLAMP_MSS=1`) доступен, но по умолчанию выключен: C9
  терминируется локально на `awg0`, PMTU black hole не возникает (Q8).
- Хранение/ротация ключей и версионирование профиля обфускации — вне Этапа 0
  (вынесенная задача Q5/Q6).
