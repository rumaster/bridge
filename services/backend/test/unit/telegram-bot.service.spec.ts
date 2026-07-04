import { TelegramCodeDeliveryService } from "../../src/modules/identity/telegram-bot.service";
import type { TelegramCodeDelivery } from "../../src/modules/identity/telegram-bot.service";

/**
 * Регресс #187: доставка кода входа падала с «chat not found», потому что бот
 * писал приватному пользователю по @username, а Telegram Bot API так не умеет —
 * нужен числовой chat_id. Тесты фиксируют, что сервис (1) резолвит @username →
 * числовой chat_id через getUpdates и повторяет отправку, (2) при невозможности
 * даёт подробную диагностику (error_code + description + actionable-подсказка).
 */
describe("TelegramCodeDeliveryService (issue #187)", () => {
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

  function silenceLogger(service: TelegramCodeDeliveryService): {
    error: jest.SpyInstance;
    log: jest.SpyInstance;
    warn: jest.SpyInstance;
  } {
    const logger = (
      service as unknown as {
        logger: { error: () => void; log: () => void; warn: () => void };
      }
    ).logger;

    return {
      error: jest.spyOn(logger, "error").mockImplementation(() => undefined),
      log: jest.spyOn(logger, "log").mockImplementation(() => undefined),
      warn: jest.spyOn(logger, "warn").mockImplementation(() => undefined),
    };
  }

  it("retains the code in memory and reports the note when no bot token is configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const service = new TelegramCodeDeliveryService();

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: false, note: "telegram_bot_not_configured" });
    expect(service.consumeDelivery("req-1")).toMatchObject({ code: "123456" });
  });

  it("resolves @username → numeric chat_id via getUpdates and re-delivers (root cause of #187)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockImplementation((url: string, init: { body: string }) => {
      if (String(url).includes("/getUpdates")) {
        return Promise.resolve(
          jsonResponse(200, {
            ok: true,
            result: [
              {
                message: {
                  chat: { id: 555000111, type: "private", username: "arama7771" },
                  from: { id: 555000111, username: "arama7771" },
                },
              },
            ],
          }),
        );
      }

      // sendMessage: fails by @username, succeeds by numeric chat_id.
      const body = JSON.parse(init.body);
      if (String(body.chat_id).startsWith("@")) {
        return Promise.resolve(
          jsonResponse(400, { description: "Bad Request: chat not found", error_code: 400, ok: false }),
        );
      }

      return Promise.resolve(jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    });
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    silenceLogger(service);

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: true });

    const sendCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes("/getUpdates"));
    // Первая отправка — по @username (провал), вторая — по числовому chat_id.
    expect(JSON.parse(sendCalls[0][1].body as string).chat_id).toBe("@arama7771");
    expect(JSON.parse(sendCalls[1][1].body as string).chat_id).toBe("555000111");
  });

  it("caches the resolved numeric chat_id so the next delivery skips the @username attempt", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockImplementation((url: string, init: { body: string }) => {
      if (String(url).includes("/getUpdates")) {
        return Promise.resolve(
          jsonResponse(200, {
            ok: true,
            result: [{ message: { from: { id: 777, username: "arama7771" } } }],
          }),
        );
      }

      const body = JSON.parse(init.body);
      if (String(body.chat_id).startsWith("@")) {
        return Promise.resolve(
          jsonResponse(400, { description: "Bad Request: chat not found", error_code: 400, ok: false }),
        );
      }

      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    silenceLogger(service);

    await service.deliver(delivery);
    fetchMock.mockClear();

    const result = await service.deliver({ ...delivery, requestId: "req-2" });

    expect(result).toEqual({ delivered: true });
    // Второй раз @username не пробуем и getUpdates не дёргаем — сразу числовой id.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).chat_id).toBe("777");
  });

  it("surfaces error_code + description and an actionable hint when the chat_id cannot be resolved", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    // sendMessage: chat not found; getUpdates: no matching user → resolution fails.
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/getUpdates")) {
        return Promise.resolve(jsonResponse(200, { ok: true, result: [] }));
      }

      return Promise.resolve(
        jsonResponse(400, { description: "Bad Request: chat not found", error_code: 400, ok: false }),
      );
    });
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    const spies = silenceLogger(service);

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: false, note: "telegram_delivery_failed" });
    const errorMessage = spies.error.mock.calls[0]?.[0] ?? "";
    expect(errorMessage).toContain("error_code 400");
    expect(errorMessage).toContain("Bad Request: chat not found");
    expect(errorMessage).toContain("@arama7771");
    // Actionable-подсказка про Start выводится отдельным warning.
    const warned = spies.warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warned).toContain("Start");
  });

  it("warns and degrades gracefully when getUpdates is unavailable (webhook active → 409)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/getUpdates")) {
        return Promise.resolve(
          jsonResponse(409, {
            description: "Conflict: can't use getUpdates method while webhook is active",
            error_code: 409,
            ok: false,
          }),
        );
      }

      return Promise.resolve(
        jsonResponse(400, { description: "Bad Request: chat not found", error_code: 400, ok: false }),
      );
    });
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    const spies = silenceLogger(service);

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: false, note: "telegram_delivery_failed" });
    const warned = spies.warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warned).toContain("getUpdates unavailable");
  });

  it("sends to a numeric chat_id verbatim (no @ prefix) when telegram_username is numeric", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    silenceLogger(service);
    const result = await service.deliver({ ...delivery, telegramUsername: "123456789" });

    expect(result).toEqual({ delivered: true });
    // Числовой id уходит сразу, без getUpdates.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe("123456789");
  });

  it("delivers to @username directly for public channels/supergroups the bot manages", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    silenceLogger(service);
    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: true });
    // Успех по @username → getUpdates не нужен.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe("@arama7771");
  });

  it("reports a network error note when fetch rejects before a response", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const fetchMock = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    mockFetch(fetchMock);

    const service = new TelegramCodeDeliveryService();
    silenceLogger(service);

    const result = await service.deliver(delivery);

    expect(result).toEqual({ delivered: false, note: "telegram_network_error" });
  });
});
