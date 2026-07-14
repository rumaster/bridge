# Покомпонентный деплой на стенде. Выполняется НА СТЕНДЕ, поверх remote-common.sh
# (workflow склеивает файлы и подаёт на stdin). Локально не запускается.
#
# Аргументы:
#   $1 workdir      — корень рабочей копии на стенде
#   $2 compose_file — путь к compose-файлу относительно workdir
#   $3 env_file     — путь к env-файлу относительно workdir
#   $4 sha          — коммит, который деплоим
#   $5 tag_csv      — "BRIDGE_TAG_BACKEND=<sha>,..." для деплоимых образов
#   $6 profiles_csv — compose-профили, "" если не нужны
#   $7 services_csv — сервисы к перезапуску

WORKDIR=$1
COMPOSE_FILE=$2
ENV_FILE=$3
SHA=$4
TAG_CSV=$5
PROFILES_CSV=${6:-}
SERVICES_CSV=$7

cd "$WORKDIR" || die "нет каталога $WORKDIR"

checkout_sha "$SHA"
apply_tags "$ENV_FILE" "$TAG_CSV"

mapfile -t SERVICES < <(csv_to_args "$SERVICES_CSV")
[ ${#SERVICES[@]} -gt 0 ] || die "не передан ни один сервис"

PROFILE_ARGS=()
while IFS= read -r p; do
  [ -n "$p" ] && PROFILE_ARGS+=(--profile "$p")
done < <(csv_to_args "$PROFILES_CSV")

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "${PROFILE_ARGS[@]}" "$@"
}

log "Тяну образы из GHCR: ${SERVICES[*]}"
compose pull "${SERVICES[@]}"

# --no-build — не «оптимизация», а предохранитель: на RF edge (908 МБ RAM) сборка
# уходит в OOM и роняет стенд. Если образ почему-то не подтянулся, честно падаем
# здесь, а не пытаемся собрать его на месте.
log "Поднимаю сервисы: ${SERVICES[*]}"
compose up -d --no-build "${SERVICES[@]}"

log "Состояние"
compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'

# Только висячие (untagged) слои — старые sha-теги не трогаем, чтобы откат
# оставался мгновенным (образ уже на диске).
docker image prune -f >/dev/null 2>&1 || true

log "Готово: $SHA -> ${SERVICES[*]}"
