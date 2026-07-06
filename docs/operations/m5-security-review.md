# M5 Security Review (CP-9, ТЗ §23)

Дата локальной проверки: 2026-07-04.

Документ фиксирует регрессионный security review приёмки M5. Проверки не вводят
новых контрактов и подтверждают инварианты §23 на существующих замороженных
поверхностях. Ведущая улика — интеграционный тест SVC-DATA
`tests/integration/data-platform.test.ts` (реальный PostgreSQL через
Testcontainers), дополнённый регламентом
`docs/operations/data-platform-backup-restore.md`.

## Команды

```sh
npm run test:integration    # tests/integration/*.test.ts (в т. ч. data-platform)
npm run test:contract       # контрактный набор без дрейфа
npm run test:e2e            # полный e2e-набор §26.6
```

## 1. Изоляция арендаторов (RLS по всем ресурсам)

- Политики RLS включены и форсированы (`rowsecurity = true`, `forcerowsecurity = true`)
  для всех арендаторских таблиц: `organizations`, `configurations`, `audit_events`,
  `auth_sessions`, `clients`, `endpoints`, `conversations`, `messages`,
  `message_delivery_attempts`, `broadcast_messages`, `notifications`,
  `notification_settings`, `edge_message_buffer` и др. (см. `TENANT_RLS_TABLES`).
- Тест сеет данные двух организаций (`ORG_A`, `ORG_B`) и подтверждает, что при
  `app.current_organization_id = ORG_A` видны только строки `ORG_A`; строки
  `ORG_B` невидимы на SELECT и недоступны на UPDATE/DELETE.
- KB-поиск (pgvector) изолирован по `organization_id`
  (`tests/integration/ai-rag-kb.test.ts`).

## 2. Валидация Transform Node (фаззинг структуры)

- Backend — единственный санкционированный способ изменения данных из
  Workflow/AI; Transform Node валидируется на сохранении схемы, невалидные
  структуры отклоняются серверной валидацией.
- Улики: `tests/contract/c4-onboarding-command-cp5.test.ts`,
  `services/backend/test/unit` (ai/fbp facades), `tests/e2e/workflow-fbp-m5-cp9.test.ts`.

## 3. Хранение и ротация секретов

- Секреты каналов хранятся только по ссылке `secret://<provider>/<org>/<name>`
  (`credentials_ref`); тест подтверждает, что `config` не содержит поля `secret`
  и что запись с plaintext-секретом отклоняется.
- Ни одна таблица не имеет столбцов вида `*_api_key/_password/_secret/_token`
  с открытым значением (проверка по `information_schema.columns`).
- Ротация выполняется заменой значения в менеджере секретов без изменения
  `credentials_ref` — контур приложения переживает ротацию без миграции данных.

## 4. Защита append-only аудита

- Функция-триггер `app.reject_append_only_mutation()` активна; попытки UPDATE и
  DELETE строки `audit_events` завершаются ошибкой `append-only`.
- INSERT в `audit_events` разрешён (изменяющие операции обязаны писать аудит,
  §22.9/§23.8).

## 5. Обезличивание при целостном аудите

- Функция `app.anonymize_client_personal_data(uuid,uuid,uuid,text,text)`
  обезличивает ПДн клиента (`clients.anonymized_at`, индекс
  `clients_anonymized_at_idx`), не нарушая append-only аудит и ссылочную
  целостность — история сообщений и аудит остаются полными.

## 6. Отзыв сессий и доступа

- `auth_sessions` под RLS и арендной изоляцией; отзыв сессии/доступа
  выполняется в контуре SVC-IDN (`services/identity-platform`), аудит входов и
  ошибок аутентификации пишется append-only.
- Улики: `docs/plan/services/02-identity-platform.md` (Статус M5),
  `tests/integration/data-platform.test.ts` (auth_sessions RLS).

## Итог

Все инварианты §23, вынесенные на приёмку M5, покрыты автоматической регрессией.
Нарушений изоляции, утечек секретов, обхода append-only аудита и брешей
обезличивания не обнаружено. Блокеров безопасности для финальной заморозки v1 нет.
