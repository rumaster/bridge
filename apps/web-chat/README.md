# Bridge Web Chat

`@bridge/web-chat` — M0-каркас встраиваемого Web Chat виджета. Он фиксирует Web
Chat как первый канал будущего CP-1: вертикальный срез M1 начнется с сценария
«посетитель пишет в Web Chat -> менеджер отвечает -> посетитель получает ответ».

## Embed

Встраивающая страница должна предоставить mount point:

```html
<div id="bridge-web-chat-root"></div>
<script type="module">
  import { mountBridgeWebChat } from "/dist/bridge-web-chat.js";

  await mountBridgeWebChat("#bridge-web-chat-root", {
    apiBaseUrl: "/api/v1",
    conversationId: "conversation-id",
    organizationId: "organization-id"
  });
</script>
```

`mountBridgeWebChat` является ленивым loader API: основной React-код виджета
загружается через динамический `import()` только при вызове mount.

## M0 scope

- React + Vite + TypeScript приложение в `apps/web-chat`.
- Встраиваемый ESM bundle с отдельной точкой монтирования.
- Базовая лента сообщений и поле ввода.
- MSW mock REST для C3.messages/C1 и mock WebSocket C7.
- Unit-тесты на mount widget, empty thread render и message input render.

`packages/ui-kit` и `packages/api-client` пока не экспортируют готовые API, поэтому
внутри приложения есть локальные временные заглушки с TODO на замену в M1.

## M4 scope — CP-7 «Подключение клиентов РФ через Edge Cluster»

Реализует §5.5 плана `docs/plan/services/13-web-chat.md`: устойчивое подключение
клиента РФ к Backend через **Edge Cluster** (ТЗ §18.7, §7.6, §5.2). Серверный
буфер Edge/C9 остаётся зоной ответственности SVC-EDGE — виджет его только
потребляет.

- **Прозрачный проход через Edge.** Если задан `edgeBaseUrl`, REST и WebSocket
  трафик виджета идёт через Edge Cluster без изменения контрактов C3.messages/C7.
  В заголовке виджета появляется отметка «· через Edge».
- **Устойчивость к разрыву.** Клиентский буфер исходящих реплик
  (`outboundQueue`, FIFO) удерживает неотправленные сообщения при обрыве канала;
  после восстановления соединения виджет **автоматически переотправляет** буфер.
- **Идемпотентность / дедупликация.** Каждая реплика несёт сквозной
  `idempotency_key` (= `message_id`, ТЗ §11.12), стабильный между попытками, —
  повторная отправка не создаёт дублей, сервер возвращает уже созданное
  сообщение.
- **Порядок без разрывов.** Реплики сохраняют FIFO-порядок в рамках
  Conversation/Endpoint (ТЗ §7.10); после переподключения лента докручивается по
  `sequence_number` без пропусков.

### Опции монтирования (CP-7)

- `edgeBaseUrl?: string` — база Edge Cluster для клиентов РФ. Если задана,
  REST/WS прозрачно идут через Edge; контракты не меняются.
- `outboundQueueStorage?: Storage | null` — хранилище буфера исходящих (по
  умолчанию `sessionStorage` вкладки); `null` отключает персистентность.
- `realtimeReconnectDelayMs?: number` — задержка автопереподключения WS, после
  которого запускается переотправка буфера.

### Тесты

- **unit** — `outboundQueue` (буфер/переотправка/дедуп/порядок).
- **integration** — `test/web-chat-edge-resilience.test.tsx`: эмуляция разрыва
  (mock Backend/WS), переотправка без дублей, корректный порядок нескольких
  реплик.
- **e2e (Playwright)** — `test/e2e/web-chat.cp7.spec.ts`, сценарий CP-7 «Потеря
  соединения»: разрыв канала до Edge → буферизация реплики → восстановление →
  автопереотправка без дублей и с ответом менеджера.

## M5 scope — приёмка доступности, устойчивости и производительности

- **Accessibility-инварианты.** Лента сообщений объявлена как `role="log"` с live
  region, состояние соединения — `role="status"`, поле ввода связано с состоянием
  через `aria-describedby`, а после отправки фокус возвращается в поле ввода для
  непрерывного клавиатурного сценария.
- **Встраивание.** CSS виджета не публикует широкие `:root`/`body`/`button`
  селекторы в страницу хоста; базовая типографика и controls scoped внутри
  `.bridge-chat-shell`.
- **Reconnect и Edge replay.** C7-подписка стартует с последнего уже загруженного
  `sequence_number`, поэтому первый event после истории может обнаружить gap и
  запустить catch-up. Повторный replay по `event_id` не добавляет дубли.
- **Bundle budget.** `npm run build --workspace @bridge/web-chat` после Vite-сборки
  запускает `scripts/check-bundle-size.ts`: проверяет ленивый loader
  `bridge-web-chat.js`, gzip-бюджет production JS и raw CSS budget.

## Commands

- `npm run dev --workspace @bridge/web-chat` — локальный стенд с MSW в dev mode.
  Параметр `?edge=1` включает прохождение через Edge Cluster (CP-7).
- `npm test --workspace @bridge/web-chat` — unit/integration тесты (Vitest).
- `npm run test:e2e --workspace @bridge/web-chat` — e2e-сценарий CP-7 (Playwright).
- `npm run build --workspace @bridge/web-chat` — сборка widget bundle и проверка
  budget размера.
