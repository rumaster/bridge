# Telegram Console

`clients/telegram-console` — необязательный подготовительный каркас SVC-TGC для
M0. Он нужен только для ранней проверки формы Telegram-бот клиента менеджера и не
включает Telegram Console в критический путь M0/M1.

## Статус M0

- Каркас не блокирует M0 gate.
- Каркас не участвует в CP-1 и не блокирует его.
- Основная работа Telegram Console начинается в M3, когда появятся готовые
  уведомления, диалоги и отправка ответа через Backend.
- В M0 добавлены только mock Telegram API adapter, routing команд/inline-кнопок и
  черновая точка привязки аккаунта поверх будущего `C3.auth`.

## Что есть сейчас

- `/start` — маршрутизируется в draft-привязку аккаунта к будущему `C3.auth`
  (`POST /auth/login/telegram/start`, `POST /auth/login/telegram/verify`) без
  реальной аутентификации.
- `/dialogs` — подтверждает routing, но остаётся M3-placeholder без вызовов
  `C3.conversations`.
- `auth.link` callback — routing inline-кнопки к той же draft-привязке.
- `mock-telegram-api` — детерминированный адаптер для unit-тестов handler routing.

## Чего намеренно нет в M0/M1/M2

- Уведомлений через `C10.notifications`.
- Просмотра активного диалога и истории через `C3.conversations`.
- Ответа клиенту через `C3.messages`.
- AI-подсказок через `C4`.

Эти сценарии относятся к основной работе SVC-TGC в M3+ по
`docs/plan/services/14-telegram-console.md`.

## Проверки

```bash
npm run test --workspace @bridge/telegram-console
npm run build --workspace @bridge/telegram-console
```
