import { TelegramCodeDeliveryService } from "../../src/modules/identity/telegram-bot.service";
import type { TelegramCodeDelivery } from "../../src/modules/identity/telegram-bot.service";

/**
 * Регресс #187: доставка кода входа падала с невнятным «HTTP 400».
 * Тесты фиксируют, что сервис читает тело ответа Telegram и выдаёт подробную
 * диагностику (error_code + description) вместо голого статуса.
 */
describe("TelegramCodeDeliveryService diagnostics (issue #187)", () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousBase = process.env.TELEGRAM_API_BASE_URL;
  const originalFetch = global.fetch;

  const delivery: TelegramCodeDelivery = {
    code: "123456",
    expiresAt: "2026-07-04T10:05:00.000Z",
    purpose: "telegram_login",
    requestId: "req-1",
    telegramUsername: "arama7771",
    userId: "user-1",
  };

  afterEach(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
    if (previousBase === undefined) {
      delete process.env.TELEGRAM_API_BASE_URL;
    } else {
      process.env.TELEGRAM_API_BASE_URL = previousBase;
    }
  });

  function mockFetch(impl: jest.Mock): void {
    global.fetch = impl as unknown as typeof fetch;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return {
      json: async () => body,
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
    } as unknown as Response;
  }

  it("retains the code in memory and reports the note when no bot token is configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const service = new TelegramCodeDeliveryService();

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: false, note: "telegram_bot_not_configured" });
    expect(service.consumeDelivery("req-1")).toMatchObject({ code: "123456" });
  });

  it("surfaces the Telegram error_code and description on HTTP 400 (root cause of #187)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(400, {
        description: "Bad Request: chat not found",
        error_code: 400,
        ok: false,
      }),
    );
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    const errorSpy = jest
      .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, "error")
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, "warn")
      .mockImplementation(() => undefined);

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: false, note: "telegram_delivery_failed" });
    const errorMessage = errorSpy.mock.calls[0]?.[0] ?? "";
    expect(errorMessage).toContain("error_code 400");
    expect(errorMessage).toContain("Bad Request: chat not found");
    expect(errorMessage).toContain("@arama7771");
    // Actionable-подсказка выводится отдельным warning.
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Start");
  });

  it("sends to a numeric chat_id verbatim (no @ prefix) when telegram_username is numeric", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    const result = await service.deliver({ ...delivery, telegramUsername: "123456789" });

    expect(result).toEqual({ delivered: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe("123456789");
  });

  it("prefixes a @ for username-based chat ids", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    await service.deliver(delivery);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe("@arama7771");
  });

  it("reports a network error note when fetch rejects before a response", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    jest
      .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, "error")
      .mockImplementation(() => undefined);

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: false, note: "telegram_network_error" });
  });

  it("delivers successfully and returns delivered:true on ok response", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: true });
  });
});
