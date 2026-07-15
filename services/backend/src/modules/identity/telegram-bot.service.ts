import { Injectable, Logger } from "@nestjs/common";

/**
 * Полезная нагрузка доставки одноразового кода входа в Telegram.
 */
export interface TelegramCodeDelivery {
  code: string;
  expiresAt: string;
  purpose: string;
  requestId: string;
  telegramId?: null | string;
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
  result?: unknown;
}

/**
 * Минимальная форма пользователя/чата из Telegram Bot API. Нас интересует только
 * связка «числовой id ↔ @username», чтобы доставлять код приватным пользователям
 * по их chat_id (по @username Bot API писать приватным адресатам не умеет).
 */
export interface TelegramPeer {
  first_name?: string;
  id?: number;
  last_name?: string;
  type?: string;
  username?: string;
}

export interface TelegramUpdate {
  callback_query?: { from?: TelegramPeer };
  channel_post?: { chat?: TelegramPeer };
  chat_member?: { chat?: TelegramPeer; from?: TelegramPeer };
  edited_message?: { chat?: TelegramPeer; from?: TelegramPeer };
  message?: { chat?: TelegramPeer; from?: TelegramPeer; text?: string };
  my_chat_member?: { chat?: TelegramPeer; from?: TelegramPeer };
  update_id: number;
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
const TELEGRAM_BOT_USERNAME_ENV = "TELEGRAM_BOT_USERNAME";
const TELEGRAM_API_BASE_ENV = "TELEGRAM_API_BASE_URL";
const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_RETAINED_DELIVERIES = 50;
const GET_UPDATES_LIMIT = 100;

/**
 * Доставка одноразовых кодов авторизации через Telegram-бота.
 *
 * Бот активируется переменной окружения TELEGRAM_BOT_TOKEN. Когда токен задан,
 * сервис вызывает Telegram Bot API `sendMessage`.
 *
 * Ключевой момент (регресс #187): Telegram Bot API **не умеет** писать приватному
 * пользователю по `@username` — адресата нужно хранить и передавать как числовой
 * `users.telegram_id`/`chat_id`. Если `telegram_id` ещё не заполнен, сервис
 * оставляет старые fallback-ветки: числовой `telegram_username` используется как
 * `chat_id`, а при `chat not found` по `@username` выполняется best-effort
 * резолвинг через `getUpdates`.
 *
 * Когда токен не задан (локальная разработка/CI), код не отправляется наружу,
 * а удерживается в памяти, чтобы автотесты могли его прочитать через
 * {@link TelegramCodeDeliveryService.consumeDelivery}.
 */
@Injectable()
export class TelegramCodeDeliveryService {
  private readonly logger = new Logger(TelegramCodeDeliveryService.name);
  private readonly retained: TelegramCodeDelivery[] = [];
  /** Кэш «нормализованный @username → числовой chat_id», наполняется getUpdates. */
  private readonly chatIdByUsername = new Map<string, string>();
  /** Выставляется поллером: у Bot API может быть только один потребитель getUpdates. */
  private updatesConsumerAttached = false;
  private botUsername?: null | string;

  get configured(): boolean {
    return Boolean(this.botToken);
  }

  /**
   * Заявляет поллер единственным потребителем getUpdates. Telegram отдаёт
   * обновления ровно одному читателю: параллельный getUpdates отвечает
   * 409 Conflict и ворует апдейты, поэтому best-effort резолвинг в
   * {@link refreshChatIdCache} при подключённом поллере отключается — кэш
   * наполняет сам поллер через {@link rememberChatId}.
   */
  attachUpdatesConsumer(): () => void {
    this.updatesConsumerAttached = true;

    return () => {
      this.updatesConsumerAttached = false;
    };
  }

  /** Запоминает связку «@username → chat_id», подсмотренную поллером в апдейте. */
  rememberChatId(username: string, chatId: number | string): void {
    this.chatIdByUsername.set(normalizeUsername(username), String(chatId));
  }

  /**
   * Читает обновления бота. Используется только поллером: offset подтверждает
   * предыдущую порцию, поэтому вызывать метод из другого места нельзя.
   */
  async fetchUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({
      limit: String(GET_UPDATES_LIMIT),
      timeout: String(timeoutSeconds),
    });
    if (offset !== undefined) {
      params.set("offset", String(offset));
    }

    const response = await fetch(`${this.apiBase}/bot${this.botToken}/getUpdates?${params}`, {
      method: "GET",
      signal,
    });
    const payload = await readTelegramPayload(response);

    if (!response.ok || payload?.ok === false) {
      throw new TelegramDeliveryError(
        `Telegram getUpdates failed (HTTP ${response.status}${
          payload?.error_code ? `, error_code ${payload.error_code}` : ""
        }): ${payload?.description ?? response.statusText ?? "unknown error"}`,
        { note: "telegram_get_updates_failed" },
      );
    }

    return Array.isArray(payload?.result) ? (payload.result as TelegramUpdate[]) : [];
  }

  /**
   * @username бота для deep-link `t.me/<bot>?start=<token>`. Берётся из
   * TELEGRAM_BOT_USERNAME, иначе разрешается через getMe и кэшируется.
   */
  async getBotUsername(): Promise<null | string> {
    const configured = process.env[TELEGRAM_BOT_USERNAME_ENV]?.trim().replace(/^@/, "");
    if (configured) {
      return configured;
    }

    if (this.botUsername !== undefined) {
      return this.botUsername;
    }

    if (!this.configured) {
      this.botUsername = null;

      return null;
    }

    try {
      const response = await fetch(`${this.apiBase}/bot${this.botToken}/getMe`, { method: "GET" });
      const payload = await readTelegramPayload(response);
      const username = (payload?.result as TelegramPeer | undefined)?.username;

      this.botUsername = username ?? null;

      if (!username) {
        this.logger.warn(
          `Telegram getMe did not return a bot username (HTTP ${response.status}): ${
            payload?.description ?? "unknown error"
          }. Set ${TELEGRAM_BOT_USERNAME_ENV} to build registration deep links.`,
        );
      }
    } catch (cause) {
      // Не кэшируем сетевой сбой: следующая попытка должна повторить getMe.
      this.logger.warn(
        `Could not resolve the bot username via getMe: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );

      return null;
    }

    return this.botUsername;
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

  private get apiBase(): string {
    const base = process.env[TELEGRAM_API_BASE_ENV]?.trim() || DEFAULT_TELEGRAM_API_BASE;

    return base.replace(/\/+$/, "");
  }

  private retain(delivery: TelegramCodeDelivery): void {
    this.retained.push(delivery);

    while (this.retained.length > MAX_RETAINED_DELIVERIES) {
      this.retained.shift();
    }
  }

  private async sendViaBotApi(delivery: TelegramCodeDelivery): Promise<string> {
    // Первая попытка: сохранённый users.telegram_id используется как chat_id
    // напрямую. Остальные ветки оставлены для обратной совместимости и диагностики
    // старых записей, где chat_id ещё не заполнен.
    const primaryChatId = this.resolveChatId(delivery);
    const primary = await this.sendMessage(primaryChatId, delivery);

    if (primary.ok) {
      return primaryChatId;
    }

    // Классическая причина #187: писали по @username приватному пользователю →
    // «chat not found». Пробуем узнать числовой chat_id через getUpdates (там
    // виден каждый, кто недавно писал боту, в т.ч. нажимал Start) и повторяем.
    if (isChatNotFound(primary.payload) && primaryChatId.startsWith("@")) {
      const numericChatId = await this.resolveNumericChatId(delivery.telegramUsername);

      if (numericChatId && numericChatId !== primaryChatId) {
        const retry = await this.sendMessage(numericChatId, delivery);

        if (retry.ok) {
          return numericChatId;
        }

        throw deliveryError(numericChatId, retry);
      }
    }

    throw deliveryError(primaryChatId, primary);
  }

  private async sendMessage(
    chatId: string,
    delivery: TelegramCodeDelivery,
  ): Promise<{ ok: boolean; payload?: TelegramApiResponse; status: number; statusText: string }> {
    const url = `${this.apiBase}/bot${this.botToken}/sendMessage`;

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

    return {
      ok: response.ok && payload?.ok !== false,
      payload,
      status: response.status,
      statusText: response.statusText ?? "",
    };
  }

  /**
   * Строит начальное значение chat_id для sendMessage. users.telegram_id имеет
   * приоритет. Числовой telegram_username трактуется как legacy chat_id напрямую;
   * иначе используется ранее найденный числовой id из кэша, а при его отсутствии —
   * @username.
   */
  private resolveChatId(delivery: TelegramCodeDelivery): string {
    const telegramId = delivery.telegramId?.trim();
    if (telegramId) {
      return telegramId;
    }

    const telegramUsername = delivery.telegramUsername;
    if (/^-?\d+$/.test(telegramUsername)) {
      return telegramUsername;
    }

    const cached = this.chatIdByUsername.get(normalizeUsername(telegramUsername));

    return cached ?? `@${telegramUsername}`;
  }

  /**
   * Пытается узнать числовой chat_id для @username, опросив getUpdates. Возвращает
   * undefined, если пользователь не писал боту недавно или getUpdates недоступен
   * (например, включён webhook — тогда Bot API отвечает 409).
   */
  private async resolveNumericChatId(telegramUsername: string): Promise<string | undefined> {
    const normalized = normalizeUsername(telegramUsername);
    const cached = this.chatIdByUsername.get(normalized);
    if (cached) {
      return cached;
    }

    await this.refreshChatIdCache();

    return this.chatIdByUsername.get(normalized);
  }

  /**
   * Опрашивает getUpdates и наполняет кэш «username → chat_id». Вызывается без
   * offset — обновления не подтверждаются, поэтому фоновому поллингу бота (если он
   * появится) метод не мешает. Ошибки не пробрасываются: резолвинг «максимальных
   * усилий», доставка деградирует до fallback на @username.
   */
  private async refreshChatIdCache(): Promise<void> {
    // Апдейты уже читает поллер; второй getUpdates получил бы 409 и отобрал бы у
    // него часть обновлений. Кэш в этом режиме наполняется через rememberChatId.
    if (this.updatesConsumerAttached) {
      return;
    }

    const url = `${this.apiBase}/bot${this.botToken}/getUpdates?limit=${GET_UPDATES_LIMIT}`;

    let response: Response;
    try {
      response = await fetch(url, { method: "GET" });
    } catch (cause) {
      this.logger.warn(
        `Could not resolve numeric chat_id via getUpdates (network error): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );

      return;
    }

    const payload = await readTelegramPayload(response);

    if (!response.ok || payload?.ok === false) {
      // 409 Conflict = активен webhook; getUpdates в этом режиме недоступен.
      this.logger.warn(
        `getUpdates unavailable for numeric chat_id resolution (HTTP ${response.status}` +
          `${payload?.error_code ? `, error_code ${payload.error_code}` : ""}): ${
            payload?.description ?? response.statusText ?? "unknown error"
          }. If a webhook is configured, store the numeric chat_id in users.telegram_id.`,
      );

      return;
    }

    const updates = Array.isArray(payload?.result) ? (payload.result as TelegramUpdate[]) : [];
    let learned = 0;

    for (const peer of collectPeers(updates)) {
      if (peer.username && typeof peer.id === "number") {
        this.chatIdByUsername.set(normalizeUsername(peer.username), String(peer.id));
        learned += 1;
      }
    }

    if (learned > 0) {
      this.logger.log(`Learned ${learned} Telegram chat_id(s) from getUpdates.`);
    }
  }
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

function isChatNotFound(payload?: TelegramApiResponse): boolean {
  return /chat not found/i.test(payload?.description ?? "");
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Достаёт из обновлений getUpdates всех пользователей/приватные чаты с известным
 * @username и числовым id. Для приватного чата chat.id совпадает с id
 * отправителя, поэтому по любому из них можно доставить код.
 */
function collectPeers(updates: TelegramUpdate[]): TelegramPeer[] {
  const peers: TelegramPeer[] = [];

  for (const update of updates) {
    const containers = [
      update.message,
      update.edited_message,
      update.my_chat_member,
      update.chat_member,
      update.channel_post,
      update.callback_query,
    ];

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
  }

  return peers;
}

function deliveryError(
  chatId: string,
  attempt: { payload?: TelegramApiResponse; status: number; statusText: string },
): TelegramDeliveryError {
  const errorCode = attempt.payload?.error_code ?? attempt.status;
  const description = attempt.payload?.description ?? (attempt.statusText || "unknown error");

  return new TelegramDeliveryError(
    `Telegram Bot API rejected sendMessage for chat_id ${chatId} ` +
      `(HTTP ${attempt.status}, error_code ${errorCode}): ${description}`,
    { hint: buildDeliveryHint(chatId, description), note: "telegram_delivery_failed" },
  );
}

/**
 * Формирует actionable-подсказку по тексту ошибки Telegram, чтобы оператор
 * понимал первопричину без чтения документации Bot API.
 */
function buildDeliveryHint(chatId: string, description: string): string | undefined {
  if (/chat not found/i.test(description)) {
    return (
      `Telegram не может доставить код на ${chatId}: бот пишет приватным пользователям ` +
      `только по числовому chat_id, а не по @username. Сохраните числовой chat_id ` +
      `в users.telegram_id; для старых записей можно попросить пользователя открыть ` +
      `диалог с ботом и нажать Start, чтобы fallback попытался подхватить chat_id из getUpdates.`
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
  if (delivery.purpose === "registration") {
    return (
      `Bridge SaaS: код подтверждения регистрации — ${delivery.code}. ` +
      `Он действует до ${delivery.expiresAt}. ` +
      `Введите его на странице регистрации, чтобы создать организацию. ` +
      `Если вы не начинали регистрацию, проигнорируйте это сообщение.`
    );
  }

  return (
    `Bridge SaaS: код для входа — ${delivery.code}. ` +
    `Он действует до ${delivery.expiresAt}. ` +
    `Если вы не запрашивали вход, проигнорируйте это сообщение.`
  );
}
