import {
  isOriginAllowed,
  parseAllowedOrigins,
  resolveClientIp,
} from "../../src/modules/web-chat/web-chat-access";

/**
 * Контроль доступа публичных Web Chat-ручек (W4, WG-10/WG-11,
 * docs/plan/web-chat-channel-production.md): allow-list Origin из config канала и
 * резолв источника за Edge/прокси.
 */
describe("web-chat-access", () => {
  describe("parseAllowedOrigins", () => {
    it("читает widget_origin (строку) и widget_origins (массив), нормализует", () => {
      expect(parseAllowedOrigins({ widget_origin: "https://Example.test/" })).toEqual([
        "https://example.test",
      ]);
      expect(
        parseAllowedOrigins({ widget_origins: ["https://a.test", "https://B.test/"] }),
      ).toEqual(["https://a.test", "https://b.test"]);
    });

    it("пусто при отсутствии конфигурации origin", () => {
      expect(parseAllowedOrigins(null)).toEqual([]);
      expect(parseAllowedOrigins({})).toEqual([]);
      expect(parseAllowedOrigins({ widget_origin: 42 as unknown as string })).toEqual([]);
    });
  });

  describe("isOriginAllowed", () => {
    it("разрешает любой origin, если allow-list не задан (opt-in)", () => {
      expect(isOriginAllowed({}, "https://anything.test")).toBe(true);
      expect(isOriginAllowed({}, undefined)).toBe(true);
    });

    it("при заданном allow-list требует совпадения (с нормализацией)", () => {
      const config = { widget_origin: "https://shop.test" };
      expect(isOriginAllowed(config, "https://shop.test")).toBe(true);
      expect(isOriginAllowed(config, "https://shop.test/")).toBe(true);
      expect(isOriginAllowed(config, "https://SHOP.test")).toBe(true);
      expect(isOriginAllowed(config, "https://evil.test")).toBe(false);
    });

    it("отсутствие Origin при заданном allow-list трактуется как запрет", () => {
      expect(isOriginAllowed({ widget_origin: "https://shop.test" }, undefined)).toBe(false);
    });
  });

  describe("resolveClientIp", () => {
    it("берёт первый хоп X-Forwarded-For", () => {
      expect(resolveClientIp("203.0.113.7, 10.0.0.1", "127.0.0.1")).toBe("203.0.113.7");
    });
    it("fallback на IP соединения без XFF", () => {
      expect(resolveClientIp(undefined, "198.51.100.9")).toBe("198.51.100.9");
    });
    it("'unknown' если ничего нет", () => {
      expect(resolveClientIp(undefined, undefined)).toBe("unknown");
    });
  });
});
