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

## Commands

- `npm run dev --workspace @bridge/web-chat` — локальный стенд с MSW в dev mode.
- `npm test --workspace @bridge/web-chat` — unit/MSW smoke tests.
- `npm run build --workspace @bridge/web-chat` — сборка widget bundle.
