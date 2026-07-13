import {
  DIRECT_REALTIME_CHANNELS,
  isDirectRealtimeChannel,
} from "../../src/modules/communication-core/internal-messaging.service";

/**
 * Ветвление egress для realtime/direct-каналов (WG-6, план
 * docs/plan/web-chat-channel-production.md, этап W1). Web Chat подключён к ядру
 * напрямую по C7/WS и не имеет внешнего egress-адаптера — такие каналы
 * исключаются из handoffEgress/SVC-INT.
 */
describe("isDirectRealtimeChannel (ветвление egress W1)", () => {
  it("относит web_chat к realtime/direct-каналам", () => {
    expect(isDirectRealtimeChannel("web_chat")).toBe(true);
    expect(DIRECT_REALTIME_CHANNELS.has("web_chat")).toBe(true);
  });

  it("НЕ относит внешние каналы (telegram/email/max) к realtime/direct", () => {
    expect(isDirectRealtimeChannel("telegram")).toBe(false);
    expect(isDirectRealtimeChannel("email")).toBe(false);
    expect(isDirectRealtimeChannel("max")).toBe(false);
    expect(isDirectRealtimeChannel("")).toBe(false);
  });
});
