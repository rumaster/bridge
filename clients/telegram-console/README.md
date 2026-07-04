# Telegram Console

`clients/telegram-console` — реализация SVC-TGC для CP-8/M4: тонкий Telegram bot
UI для менеджера поверх опубликованных Backend/Core контрактов. Сервис не
содержит бизнес-логики, хранит только Telegram chat -> server session context и
проксирует действия в C3/C4/C10.

## Статус CP-8/M4

- M3 закрыт: привязка аккаунта через `C3.auth`, server session для Backend
  вызовов, C10 Telegram notification cards, C3 dialogs/history/messages и
  Manager Workspace links.
- M4 закрыт: C4 AI suggestions (`summary`, `reply`, `kb`, `translate`), быстрые
  ответы/templates и graceful degradation, когда AI недоступен.
- M5 rate limits и массовый throttling уведомлений остаются вне scope.

## Что есть сейчас

- `/start` — запускает Telegram login (`POST /auth/login/telegram/start`) и
  подтверждает его (`POST /auth/login/telegram/verify`) в CP-8 mock Backend API.
- `/dialogs` — читает активные диалоги через `GET /conversations` и карточки
  клиентов через `GET /clients/{clientId}`.
- `dialog.open:*` — открывает C3 conversation history через
  `GET /conversations/{id}/messages`.
- `reply.prompt:*` и `reply.quick:*` — отправляют ответ менеджера через
  идемпотентный `POST /messages` с `idempotency_key`.
- `ai.summary:*`, `ai.reply:*`, `ai.kb:*`, `ai.translate:*` — запрашивают
  `POST /ai/assistant:suggest`; подсказка применяется менеджером вручную.
- `deliverNotification()` — рендерит C10 Telegram card с inline actions:
  открыть диалог, ответить, запросить AI summary, открыть Manager Workspace.

## Деградация

Если C4 недоступен, router возвращает статус `degraded` и отправляет менеджеру
сообщение, что AI недоступен. C10 notification cards, просмотр C3 диалогов и
`POST /messages` продолжают работать.

## Проверки

```bash
npm run test --workspace @bridge/telegram-console
npm run build --workspace @bridge/telegram-console
npm run test:contract
node --test tests/e2e/telegram-console-cp8.test.mjs
```
