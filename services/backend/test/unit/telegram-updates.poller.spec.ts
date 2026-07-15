import { TelegramUpdatesPoller } from "../../src/modules/identity/telegram-updates.poller";
import type { RegistrationService } from "../../src/modules/identity/registration.service";
import type { TelegramCodeDeliveryService } from "../../src/modules/identity/telegram-bot.service";

/**
 * Поллер существует ради одного факта: Telegram Bot API не даёт написать
 * приватному пользователю по @username, поэтому числовой chat_id можно узнать
 * только из входящего апдейта. Тесты фиксируют разбор `/start <token>` и то, что
 * связка «@username → chat_id» запоминается для доставки кодов входа.
 */
describe("TelegramUpdatesPoller", () => {
  function createPoller(overrides: {
    handleStartCommand?: jest.Mock;
    rememberChatId?: jest.Mock;
  } = {}) {
    const handleStartCommand = overrides.handleStartCommand ?? jest.fn().mockResolvedValue(undefined);
    const rememberChatId = overrides.rememberChatId ?? jest.fn();

    const telegram = {
      attachUpdatesConsumer: jest.fn(() => () => undefined),
      configured: true,
      fetchUpdates: jest.fn(),
      rememberChatId,
    } as unknown as TelegramCodeDeliveryService;

    const registration = { handleStartCommand } as unknown as RegistrationService;
    const poller = new TelegramUpdatesPoller(telegram, registration);

    return { handleStartCommand, poller, rememberChatId, telegram };
  }

  function handleUpdate(poller: TelegramUpdatesPoller, update: unknown): Promise<void> {
    return (
      poller as unknown as { handleUpdate: (u: unknown) => Promise<void> }
    ).handleUpdate(update);
  }

  it("resolves a registration request from /start <token> and passes the sender's numeric id", async () => {
    const { handleStartCommand, poller } = createPoller();

    await handleUpdate(poller, {
      message: {
        chat: { id: 555000111, type: "private", username: "new_admin" },
        from: { first_name: "Ada", id: 555000111, last_name: "Lovelace", username: "new_admin" },
        text: "/start brr_token123",
      },
      update_id: 1,
    });

    expect(handleStartCommand).toHaveBeenCalledWith("brr_token123", {
      firstName: "Ada",
      id: 555000111,
      lastName: "Lovelace",
      username: "new_admin",
    });
  });

  it("accepts /start addressed to the bot by name (/start@bot <token>)", async () => {
    const { handleStartCommand, poller } = createPoller();

    await handleUpdate(poller, {
      message: {
        from: { id: 42, username: "new_admin" },
        text: "/start@bridge_auth_bot brr_token123",
      },
      update_id: 2,
    });

    expect(handleStartCommand).toHaveBeenCalledWith("brr_token123", expect.objectContaining({ id: 42 }));
  });

  it("ignores a bare /start without a registration token", async () => {
    const { handleStartCommand, poller } = createPoller();

    await handleUpdate(poller, {
      message: { from: { id: 42, username: "new_admin" }, text: "/start" },
      update_id: 3,
    });

    expect(handleStartCommand).not.toHaveBeenCalled();
  });

  it("learns @username → chat_id from any update, so login codes can be delivered", async () => {
    const { poller, rememberChatId } = createPoller();

    await handleUpdate(poller, {
      message: { from: { id: 777, username: "arama7771" }, text: "привет" },
      update_id: 4,
    });

    expect(rememberChatId).toHaveBeenCalledWith("arama7771", 777);
  });

  it("keeps polling when handling one update throws", async () => {
    const handleStartCommand = jest.fn().mockRejectedValue(new Error("db is down"));
    const { poller } = createPoller({ handleStartCommand });
    const logger = (poller as unknown as { logger: { error: () => void } }).logger;
    jest.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(
      handleUpdate(poller, {
        message: { from: { id: 42, username: "new_admin" }, text: "/start brr_token123" },
        update_id: 5,
      }),
    ).resolves.toBeUndefined();
  });
});
