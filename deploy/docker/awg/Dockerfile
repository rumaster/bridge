# syntax=docker/dockerfile:1
# AmneziaWG userspace-туннель для PoC Этапа 0 (issue #257,
# docs/plan/vpn-amneziawg-tunnel.md, решение Q1: userspace `amneziawg-go`).
#
# Образ содержит И реализацию (`amneziawg-go`, форк wireguard-go, MIT), И утилиты
# (`awg`/`awg-quick`, форк wireguard-tools) — как требует §2.1/Q6 плана. Интерфейс
# awg0 поднимается энтрипойнтом из AWG_*-переменных без общего volume (вариант A).
#
# Собирается из исходников amnezia-vpn под конкретный пин-реф, чтобы сборка была
# воспроизводимой в CI (ubuntu-latest, Q7). Работает поверх /dev/net/tun и требует
# лишь CAP_NET_ADMIN — привилегированный хост не нужен.

# --- Стадия 1: сборка amneziawg-go (userspace-реализация, TUN) ---
FROM golang:1.25-alpine AS awg-go
ARG AWG_GO_REF=master
RUN apk add --no-cache git make build-base
WORKDIR /src
RUN git clone https://github.com/amnezia-vpn/amneziawg-go.git . \
    && git checkout "${AWG_GO_REF}"
# CGO выключен → статичный бинарник без libc-зависимостей в финальном образе.
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags "-s -w" -o /out/amneziawg-go .

# --- Стадия 2: сборка amneziawg-tools (awg / awg-quick) ---
FROM alpine:3.20 AS awg-tools
ARG AWG_TOOLS_REF=master
RUN apk add --no-cache git make build-base linux-headers bash
WORKDIR /src
RUN git clone https://github.com/amnezia-vpn/amneziawg-tools.git . \
    && git checkout "${AWG_TOOLS_REF}"
RUN make -C src WITH_WGQUICK=yes \
    && make -C src install PREFIX=/usr DESTDIR=/out WITH_WGQUICK=yes

# --- Финальная стадия: рантайм ---
FROM alpine:3.20
# iproute2 (`ip`), iptables (MSS clamping/Q8), bash (awg-quick), tcpdump
# (проверка DPI-профиля — «случайный UDP», DoD Этапа 0).
# socat — минимальный HTTP-listener для awg Prometheus-экспортера (Этап 3).
RUN apk add --no-cache bash iproute2 iptables ip6tables tcpdump socat \
    && mkdir -p /var/run/amneziawg /etc/amnezia/amneziawg
COPY --from=awg-go   /out/amneziawg-go        /usr/bin/amneziawg-go
COPY --from=awg-tools /out/usr/bin/awg        /usr/bin/awg
COPY --from=awg-tools /out/usr/bin/awg-quick  /usr/bin/awg-quick
COPY deploy/docker/awg/entrypoint.sh   /usr/local/bin/entrypoint.sh
COPY deploy/docker/awg/healthcheck.sh  /usr/local/bin/healthcheck.sh
COPY deploy/docker/awg/awg-metrics.sh  /usr/local/bin/awg-metrics.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh /usr/local/bin/awg-metrics.sh

# awg-quick запускает userspace-реализацию по имени из этой переменной.
ENV WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go \
    WG_SUDO=1

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=10 \
  CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
