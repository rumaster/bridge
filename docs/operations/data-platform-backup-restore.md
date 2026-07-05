# Data Platform backup/restore, PITR и RPO/RTO

Документ фиксирует M5-регламент SVC-DATA для основной БД Application Cluster и
отдельной БД РФ-контура Edge. Обе БД обслуживаются независимо: raw-ПДн РФ-контура
и его резервные копии остаются в РФ-размещении, Application Cluster получает
только разрешённую реплику или обезличенные данные.

## Предпосылки

- PostgreSQL 16 и pgvector в основной БД.
- PostgreSQL 16 в RF-БД `edge_message_buffer`.
- На хосте оператора доступны `pg_dump`, `pg_restore`, `psql`.
- Резервные копии шифруются средствами хранилища или KMS; ключи не хранятся в
  репозитории.
- Для PITR включено архивирование WAL: `archive_mode=on`, `wal_level=replica`,
  `archive_command` в неизменяемое хранилище, мониторинг задержки архивации.

## Команды проверки

Логический backup/restore на чистую БД выполняется одним probe-командой.

```bash
node --import tsx scripts/db-backup-restore.ts probe \
  --target app \
  --source-url "$DATABASE_URL" \
  --restore-url "$RESTORE_DATABASE_URL" \
  --file ./artifacts/backups/app.dump
```

Для RF-контура используется отдельная строка подключения и отдельный dump:

```bash
node --import tsx scripts/db-backup-restore.ts probe \
  --target rf \
  --source-url "$RF_DATABASE_URL" \
  --restore-url "$RF_RESTORE_DATABASE_URL" \
  --file ./artifacts/backups/rf.dump
```

Ручной раздельный запуск:

```bash
node --import tsx scripts/db-backup-restore.ts backup --database-url "$DATABASE_URL" --file ./artifacts/backups/app.dump
node --import tsx scripts/db-backup-restore.ts restore --database-url "$RESTORE_DATABASE_URL" --file ./artifacts/backups/app.dump --clean
```

## PITR-процедура

1. Зафиксировать момент восстановления `recovery_target_time` в UTC и остановить
   запись в повреждённый primary.
2. Поднять чистый PostgreSQL 16 target той же minor-версии.
3. Развернуть последний base backup до выбранного момента.
4. Настроить `restore_command` на WAL-архив нужного контура.
5. Запустить target с `recovery_target_time`, дождаться завершения recovery и
   выполнить `pg_promote`.
6. Проверить миграции, расширение `vector`, RLS и критические счетчики:
   `organizations`, `clients`, `messages`, `configuration_history`,
   `audit_events`, `outbox_events` для Application DB; `edge_message_buffer` для RF.
7. Переключить приложение только после контрольного чтения и сверки последних
   audit-событий.

## Обезличивание и аудит

Процедура `app.anonymize_client_personal_data(...)` необратимо заменяет или
очищает идентифицирующие поля клиента, endpoint, сообщений, вложений, заметок,
тегов, identity evidence и delivery traces. UUID-ссылки не меняются, поэтому
история коммуникаций, broadcast-связи и append-only `audit_events` остаются
целостными. Факт операции пишется в `audit_events` действием
`client.anonymized`; metadata содержит только reason code, surrogate `client_id`
и счетчики затронутых строк.

## RPO/RTO

| Класс данных | RPO | RTO | Контроль |
| --- | --- | --- | --- |
| История коммуникаций и ПДн | близко к нулю | минуты - единицы часов | синхронная фиксация сообщений, WAL archive, restore-probe |
| Конфигурация, Workflow, KB | близко к нулю | минуты - единицы часов | `configuration_history`, миграционный `up/down/up`, restore-probe |
| Журнал аудита | 0 | минуты - единицы часов | append-only `audit_events`, WAL archive без пропусков |
| RF Edge buffer | ограничен TTL и емкостью буфера | после восстановления канала | отдельный RF backup/restore probe |

Контрольная M5-проба в `tests/integration/data-platform.test.ts` выполняет
логический `pg_dump`/`pg_restore` на чистую БД для обоих контуров и сверяет
критические счетчики после восстановления. Порог smoke-пробы: полный backup +
restore каждого контура меньше 300 секунд на CI/Testcontainers; целевые
эксплуатационные RTO остаются "минуты - единицы часов" по ТЗ §25.11.
Последний локальный drill: Application DB backup 0.204 с / restore 0.607 с,
RF DB backup 0.168 с / restore 0.156 с.

## Регулярность

- WAL archive: непрерывно, alert при задержке архивации больше 60 секунд.
- Base backup: не реже одного раза в сутки для каждого контура.
- Restore drill: перед CP-9, после изменения схемы M5 и далее не реже одного раза
  в квартал.
- Проверка audit RPO=0: сверка последнего `audit_events.created_at` до incident
  time с восстановленной БД.
