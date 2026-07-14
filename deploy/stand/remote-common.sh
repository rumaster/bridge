# Общие функции для remote-deploy.sh / remote-migrate.sh.
#
# Эти скрипты выполняются НА СТЕНДЕ: workflow подаёт их на stdin
# (`ssh host 'bash -s' -- args`), поэтому файл не подключается через source —
# workflow склеивает его со скриптом-потребителем. Отдельный файл нужен, чтобы
# логика не расползалась копипастой по двум скриптам.
#
# ВАЖНО: секреты (GHCR-токен) сюда не передаются аргументами — они бы засветились
# в argv (`ps` на стенде). `docker login` делается отдельным ssh-вызовом с
# токеном на stdin, см. .github/workflows/deploy.yml.

set -euo pipefail

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }

# Разворачивает "a,b,c" в аргументы через пробел (пустая строка → ничего).
csv_to_args() {
  local csv=${1:-}
  [ -z "$csv" ] && return 0
  printf '%s' "$csv" | tr ',' '\n'
}

# Переводит рабочую копию стенда точно на нужный коммит.
#
# Detached HEAD — намеренно: HEAD стенда становится машиночитаемой записью того,
# что на нём реально задеплоено, и ветка стенда не разъезжается с origin.
# .env/.env.rf не трогаются: они gitignored и переживают checkout.
checkout_sha() {
  local sha=$1
  [ -d .git ] || die "$(pwd) не git-репозиторий — стенд не подготовлен (см. CLAUDE.md, «Подготовка стенда»)"
  log "Переключаю рабочую копию на $sha"
  git fetch --depth=1 origin "$sha"
  git checkout --detach --force FETCH_HEAD
  git --no-pager log -1 --oneline
}

# Идемпотентно проставляет KEY=VALUE в env-файл стенда.
#
# Это и есть источник правды о том, какая версия каждого образа задеплоена:
# compose читает ${BRIDGE_TAG_*} отсюда, поэтому последующий ручной
# `docker compose up -d` на стенде поднимет ровно те же версии, а не «поедет».
upsert_env() {
  local file=$1 key=$2 val=$3
  [ -f "$file" ] || die "env-файл $file не найден на стенде"
  # Дозаписываем перевод строки, иначе append приклеится к последней строке.
  [ -n "$(tail -c1 "$file")" ] && printf '\n' >>"$file"
  if grep -qE "^${key}=" "$file"; then
    sed -i -E "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
  printf '  %s=%s\n' "$key" "$val"
}

apply_tags() {
  local env_file=$1 tag_csv=$2
  log "Фиксирую теги образов в $env_file"
  while IFS= read -r kv; do
    [ -z "$kv" ] && continue
    upsert_env "$env_file" "${kv%%=*}" "${kv#*=}"
  done < <(csv_to_args "$tag_csv")
}
