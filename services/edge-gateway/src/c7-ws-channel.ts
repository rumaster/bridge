/**
 * Боевой C7 WebSocket-канал Edge (этап W3, docs/plan/web-chat-channel-production.md).
 *
 * Реализация — per-subscription fan-out из [`mock-ws-channel.ts`](./mock-ws-channel.ts):
 * несмотря на историческое имя «mock», это рабочий канал (валидация C7-события,
 * дедуп по event_id, фильтрация по organization/conversation, реплей истории,
 * изоляция арендаторов). Здесь он экспортируется под продовым именем, чтобы
 * рантайм не завязывался на «mock»-нейминг. Транспорт (кадрирование, keepalive,
 * закрытие) живёт в edge-сервере ([`server.ts`](./server.ts)) поверх этого канала.
 */
export {
  createMockWebSocketChannel as createC7WebSocketChannel,
  WebSocketChannelMockValidationError as C7WebSocketChannelValidationError,
} from "./mock-ws-channel.js";
export type {
  NormalizedSubscription,
  C7ChannelConnectOptions,
  C7ChannelGetEventsOptions,
  CreateMockWebSocketChannelOptions as CreateC7WebSocketChannelOptions,
} from "./mock-ws-channel.js";
