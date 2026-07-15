import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { RegistrationService } from "./registration.service";
import type { TelegramStartActor } from "./registration.service";
import { TelegramCodeDeliveryService } from "./telegram-bot.service";
import type { TelegramPeer, TelegramUpdate } from "./telegram-bot.service";

const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 5_000;
const START_COMMAND_PATTERN = /^\/start(?:@\w+)?\s+(\S+)$/;

/**
 * Long-polling обновлений Telegram-бота авторизации (TELEGRAM_BOT_TOKEN).
 *
 * Существует ради одного факта: Bot API не даёт написать приватному пользователю
 * по @username, поэтому единственный способ узнать его числовой chat_id — принять
 * входящий апдейт. Регистрация на этом и построена: пользователь открывает
 * `t.me/<bot>?start=<token>`, а поллер связывает payload с заявкой.
 *
 * ВАЖНО: у getUpdates может быть только один потребитель на токен. SVC-TGC
 * (clients/telegram-console) при пустом TELEGRAM_CONSOLE_BOT_TOKEN откатывается
 * на TELEGRAM_BOT_TOKEN и тоже начинает long-polling — тогда оба потребителя
 * получают 409 и воруют друг у друга апдейты. Для консоли менеджера нужен
 * отдельный бот.
 */
@Injectable()
export class TelegramUpdatesPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramUpdatesPoller.name);
  private abortController?: AbortController;
  private detachUpdatesConsumer?: () => void;
  private offset?: number;
  private running = false;

  constructor(
    private readonly telegram: TelegramCodeDeliveryService,
    private readonly registration: RegistrationService,
  ) {}

  onModuleInit(): void {
    if (!this.telegram.configured) {
      this.logger.warn(
        "TELEGRAM_BOT_TOKEN is not configured; self-service registration cannot deliver codes.",
      );

      return;
    }

    if (!pollingEnabled()) {
      this.logger.warn(
        "TELEGRAM_REGISTRATION_POLLING is disabled; /start updates are not consumed and " +
          "registration requests will stay pending.",
      );

      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.detachUpdatesConsumer = this.telegram.attachUpdatesConsumer();
    void this.run();
  }

  onModuleDestroy(): void {
    this.running = false;
    this.abortController?.abort();
    this.detachUpdatesConsumer?.();
  }

  private async run(): Promise<void> {
    this.logger.log("Telegram registration long polling started.");

    while (this.running) {
      try {
        const updates = await this.telegram.fetchUpdates(
          this.offset,
          POLL_TIMEOUT_SECONDS,
          this.abortController?.signal,
        );

        for (const update of updates) {
          // Offset двигаем до обработки: упавший апдейт не должен зациклить поллер.
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) {
          break;
        }

        this.logger.warn(
          `Telegram getUpdates failed, retrying in ${RETRY_DELAY_MS}ms: ${
            error instanceof Error ? error.message : String(error)
          }. If this is a 409 Conflict, another consumer (SVC-TGC or a webhook) is ` +
            "reading updates for the same bot token.",
        );
        await sleep(RETRY_DELAY_MS);
      }
    }

    this.logger.log("Telegram registration long polling stopped.");
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    for (const peer of collectPeers(update)) {
      if (peer.username && typeof peer.id === "number") {
        this.telegram.rememberChatId(peer.username, peer.id);
      }
    }

    const message = update.message;
    const startPayload = message?.text?.trim().match(START_COMMAND_PATTERN)?.[1];
    const from = message?.from;

    if (!startPayload || !from || typeof from.id !== "number") {
      return;
    }

    try {
      await this.registration.handleStartCommand(startPayload, toStartActor(from, from.id));
    } catch (error) {
      this.logger.error(
        `Failed to handle /start for registration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function toStartActor(peer: TelegramPeer, id: number): TelegramStartActor {
  return {
    firstName: peer.first_name ?? null,
    id,
    lastName: peer.last_name ?? null,
    username: peer.username ?? null,
  };
}

function collectPeers(update: TelegramUpdate): TelegramPeer[] {
  const containers = [
    update.message,
    update.edited_message,
    update.my_chat_member,
    update.chat_member,
    update.channel_post,
    update.callback_query,
  ];
  const peers: TelegramPeer[] = [];

  for (const container of containers) {
    if (!container) {
      continue;
    }

    const withChat = container as { chat?: TelegramPeer; from?: TelegramPeer };
    if (withChat.from) {
      peers.push(withChat.from);
    }
    if (withChat.chat && withChat.chat.type === "private") {
      peers.push(withChat.chat);
    }
  }

  return peers;
}

function pollingEnabled(): boolean {
  const raw = process.env.TELEGRAM_REGISTRATION_POLLING?.trim().toLowerCase();

  return raw === undefined || raw === "" || raw === "true" || raw === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
