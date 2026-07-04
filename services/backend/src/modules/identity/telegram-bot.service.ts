import { Injectable, Logger } from "@nestjs/common";

/**
 * Полезная нагрузка доставки одноразового кода входа в Telegram.
 */
export interface TelegramCodeDelivery {
  code: string;
  expiresAt: string;
  purpose: string;
  requestId: string;
  telegramUsername: string;
  userId: string;
}

export interface TelegramDeliveryResult {
  delivered: boolean;
  note?: string;
}

const TELEGRAM_BOT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
const TELEGRAM_API_BASE_ENV = "TELEGRAM_API_BASE_URL";
const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_RETAINED_DELIVERIES = 50;

/**
 * Доставка одноразовых кодов авторизации через Telegram-бота.
 *
 * Бот активируется переменной окружения TELEGRAM_BOT_TOKEN. Когда токен задан,
 * сервис вызывает Telegram Bot API `sendMessage`. Telegram Bot API не умеет
 * инициировать переписку по @username для приватных пользователей — адресат
 * должен сам написать боту, поэтому доставка выполняется по chat_id `@username`
 * (работает для каналов/супергрупп, которыми управляет бот) в режиме
 * «максимальных усилий»: ошибка доставки логируется, но не роняет вход.
 *
 * Когда токен не задан (локальная разработка/CI), код не отправляется наружу,
 * а удерживается в памяти, чтобы автотесты могли его прочитать через
 * {@link TelegramCodeDeliveryService.consumeDelivery}.
 */
@Injectable()
export class TelegramCodeDeliveryService {
  private readonly logger = new Logger(TelegramCodeDeliveryService.name);
  private readonly retained: TelegramCodeDelivery[] = [];

  get configured(): boolean {
    return Boolean(this.botToken);
  }

  async deliver(delivery: TelegramCodeDelivery): Promise<TelegramDeliveryResult> {
    if (!this.configured) {
      this.retain(delivery);
      this.logger.warn(
        `TELEGRAM_BOT_TOKEN is not configured; login code for @${delivery.telegramUsername} ` +
          `was generated but not delivered. Set TELEGRAM_BOT_TOKEN to enable Telegram delivery.`,
      );

      return { delivered: false, note: "telegram_bot_not_configured" };
    }

    try {
      await this.sendViaBotApi(delivery);
      this.logger.log(`Delivered Telegram login code to @${delivery.telegramUsername}.`);

      return { delivered: true };
    } catch (error) {
      this.logger.error(
        `Failed to deliver Telegram login code to @${delivery.telegramUsername}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return { delivered: false, note: "telegram_delivery_failed" };
    }
  }

  /**
   * Возвращает и удаляет удержанную в памяти доставку по requestId.
   * Используется только когда бот не сконфигурирован (dev/CI) и в автотестах.
   */
  consumeDelivery(requestId: string): TelegramCodeDelivery | undefined {
    const index = this.retained.findIndex((entry) => entry.requestId === requestId);

    if (index === -1) {
      return undefined;
    }

    const [delivery] = this.retained.splice(index, 1);

    return delivery;
  }

  private get botToken(): string | undefined {
    const token = process.env[TELEGRAM_BOT_TOKEN_ENV]?.trim();

    return token ? token : undefined;
  }

  private retain(delivery: TelegramCodeDelivery): void {
    this.retained.push(delivery);

    while (this.retained.length > MAX_RETAINED_DELIVERIES) {
      this.retained.shift();
    }
  }

  private async sendViaBotApi(delivery: TelegramCodeDelivery): Promise<void> {
    const base = process.env[TELEGRAM_API_BASE_ENV]?.trim() || DEFAULT_TELEGRAM_API_BASE;
    const url = `${base.replace(/\/+$/, "")}/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      body: JSON.stringify({
        chat_id: `@${delivery.telegramUsername}`,
        disable_web_page_preview: true,
        text: composeMessage(delivery),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Telegram Bot API responded with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { description?: string; ok?: boolean };
    if (!payload.ok) {
      throw new Error(`Telegram Bot API error: ${payload.description ?? "unknown error"}`);
    }
  }
}

function composeMessage(delivery: TelegramCodeDelivery): string {
  return (
    `Bridge SaaS: код для входа — ${delivery.code}. ` +
    `Он действует до ${delivery.expiresAt}. ` +
    `Если вы не запрашивали вход, проигнорируйте это сообщение.`
  );
}
