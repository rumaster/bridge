# Прогон миграций на стенде. Выполняется НА СТЕНДЕ, поверх remote-common.sh.
#
# Аргументы:
#   $1 workdir      — корень рабочей копии на стенде
#   $2 compose_file — путь к compose-файлу относительно workdir
#   $3 env_file     — путь к env-файлу относительно workdir
#   $4 sha          — коммит, чьи миграции прогоняем
#   $5 tag_csv      — "BRIDGE_TAG_DB_TOOLS=<sha>"
#   $6 service      — compose-сервис миграций (migrate | migrate-rf)
#   $7 direction    — up | down
#   $8 mig_target   — app | rf (каталог миграций внутри db-tools)

WORKDIR=$1
COMPOSE_FILE=$2
ENV_FILE=$3
SHA=$4
TAG_CSV=$5
SERVICE=$6
DIRECTION=$7
MIG_TARGET=$8

cd "$WORKDIR" || die "нет каталога $WORKDIR"

checkout_sha "$SHA"
apply_tags "$ENV_FILE" "$TAG_CSV"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

log "Тяну образ миграций"
compose pull "$SERVICE"

log "Миграции: $DIRECTION $MIG_TARGET (сервис $SERVICE, коммит $SHA)"
# --rm: джоба одноразовая, контейнер не должен оставаться в проекте. Зависимости
# (postgres healthy) compose run поднимает сам — --no-deps намеренно НЕ ставим.
# Команду задаём явно (а не полагаемся на compose-дефолт `up`), потому что тем же
# сервисом прогоняется и down. `down` в scripts/db-migrate.ts откатывает ровно
# ОДНУ миграцию: node-pg-migrate по умолчанию берёт count=1 для направления down
# (для up — Infinity).
compose run --rm "$SERVICE" \
  node --import tsx scripts/db-migrate.ts "$DIRECTION" "$MIG_TARGET"

log "Готово: миграции $DIRECTION $MIG_TARGET на $SHA"
