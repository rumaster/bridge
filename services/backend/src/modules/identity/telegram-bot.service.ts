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

/**
 * Ответ Telegram Bot API. При ошибке `ok` равно `false`, а `description` и
 * `error_code` содержат человекочитаемую причину (например «Bad Request: chat
 * not found»), которую важно вывести в логи для диагностики.
 */
interface TelegramApiResponse {
  description?: string;
  error_code?: number;
  ok?: boolean;
}

/**
 * Ошибка доставки, обогащённая деталями от Telegram Bot API: код заметки для
 * ответа start-эндпоинта и подсказка оператору о причине отказа.
 */
class TelegramDeliveryError extends Error {
  readonly hint?: string;
  readonly note: string;

  constructor(message: string, options: { hint?: string; note: string }) {
    super(message);
    this.name = "TelegramDeliveryError";
    this.hint = options.hint;
    this.note = options.note;
  }
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
      const chatId = await this.sendViaBotApi(delivery);
      this.logger.log(`Delivered Telegram login code to ${chatId}.`);

      return { delivered: true };
    } catch (error) {
      const detail = error instanceof TelegramDeliveryError ? error : undefined;

      this.logger.error(
        `Failed to deliver Telegram login code to @${delivery.telegramUsername}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      // Подсказка выводится отдельным warning, чтобы оператор сразу видел, что
      // делать (например попросить пользователя запустить бота), а не только сам
      // код ошибки Telegram.
      if (detail?.hint) {
        this.logger.warn(detail.hint);
      }

      return { delivered: false, note: detail?.note ?? "telegram_delivery_failed" };
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

  private async sendViaBotApi(delivery: TelegramCodeDelivery): Promise<string> {
    const base = process.env[TELEGRAM_API_BASE_ENV]?.trim() || DEFAULT_TELEGRAM_API_BASE;
    const url = `${base.replace(/\/+$/, "")}/bot${this.botToken}/sendMessage`;
    const chatId = resolveChatId(delivery.telegramUsername);

    let response: Response;
    try {
      response = await fetch(url, {
        body: JSON.stringify({
          chat_id: chatId,
          disable_web_page_preview: true,
          text: composeMessage(delivery),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    } catch (cause) {
      // Сетевая ошибка (DNS/таймаут/недоступный прокси) до получения ответа.
      throw new TelegramDeliveryError(
        `Network error calling Telegram Bot API sendMessage for chat_id ${chatId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { note: "telegram_network_error" },
      );
    }

    // Тело читаем всегда: даже при HTTP 400 Telegram возвращает JSON с точной
    // причиной (error_code + description), которую и нужно показать в логах.
    const payload = await readTelegramPayload(response);

    if (!response.ok || payload?.ok === false) {
      const errorCode = payload?.error_code ?? response.status;
      const description = payload?.description ?? response.statusText ?? "unknown error";

      throw new TelegramDeliveryError(
        `Telegram Bot API rejected sendMessage for chat_id ${chatId} ` +
          `(HTTP ${response.status}, error_code ${errorCode}): ${description}`,
        { hint: buildDeliveryHint(chatId, description), note: "telegram_delivery_failed" },
      );
    }

    return chatId;
  }
}

/**
 * Строит значение chat_id для Bot API. Если в telegram_username хранится
 * числовой идентификатор чата, он используется как есть (боты умеют писать
 * пользователю по numeric chat_id, если тот уже запускал бота). Иначе значение
 * трактуется как @username — работает только для публичных каналов/супергрупп,
 * которыми управляет бот.
 */
function resolveChatId(telegramUsername: string): string {
  return /^-?\d+$/.test(telegramUsername) ? telegramUsername : `@${telegramUsername}`;
}

/**
 * Безопасно разбирает JSON-ответ Telegram. Возвращает undefined, если тело не
 * является JSON (например ошибка на промежуточном прокси).
 */
async function readTelegramPayload(response: Response): Promise<TelegramApiResponse | undefined> {
  try {
    return (await response.json()) as TelegramApiResponse;
  } catch {
    return undefined;
  }
}

/**
 * Формирует actionable-подсказку по тексту ошибки Telegram, чтобы оператор
 * понимал первопричину без чтения документации Bot API.
 */
function buildDeliveryHint(chatId: string, description: string): string | undefined {
  if (/chat not found/i.test(description)) {
    return (
      `Telegram не может доставить код на ${chatId}: бот вправе писать только тем, ` +
      `кто сам открыл диалог и нажал Start. Попросите пользователя запустить бота, ` +
      `либо сохраните его числовой chat_id в поле telegram_username.`
    );
  }

  if (/bot was blocked by the user/i.test(description)) {
    return `Пользователь заблокировал бота (${chatId}); доставка невозможна, пока он не разблокирует бота.`;
  }

  if (/bot can't initiate conversation/i.test(description)) {
    return `Бот не может начать диалог с ${chatId}: пользователь должен первым написать боту.`;
  }

  return undefined;
}

function composeMessage(delivery: TelegramCodeDelivery): string {
  return (
    `Bridge SaaS: код для входа — ${delivery.code}. ` +
    `Он действует до ${delivery.expiresAt}. ` +
    `Если вы не запрашивали вход, проигнорируйте это сообщение.`
  );
}
