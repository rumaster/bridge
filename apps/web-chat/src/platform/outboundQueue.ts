import type { WebChatMessage } from "../types";

/**
 * Клиентский буфер исходящих реплик (CP-7, M4).
 *
 * Виджет складывает неотправленные сообщения в очередь и переотправляет их после
 * восстановления соединения через Edge (ТЗ §7.9). Каждая реплика получает
 * сквозной `idempotencyKey` (= `message_id`, §11.12), который НЕ меняется между
 * попытками — это гарантирует дедупликацию на стороне ядра/Edge при повторе.
 * Очередь строго FIFO и отправляется последовательно, чтобы сохранить порядок в
 * рамках Conversation/Endpoint (§7.10).
 */

export const DEFAULT_OUTBOUND_QUEUE_STORAGE_PREFIX = "bridge.webChat.outbound";

export type OutboundQueueStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type OutboundQueueItem = {
  idempotencyKey: string;
  conversationId: string;
  endpointId: string;
  organizationId: string;
  visitorSessionId: string;
  text: string;
  createdAt: string;
  attempts: number;
};

export type OutboundEnqueueInput = {
  conversationId: string;
  endpointId: string;
  organizationId: string;
  visitorSessionId: string;
  text: string;
  /** Стабильный ключ идемпотентности; если не задан — генерируется один раз. */
  idempotencyKey?: string;
  createdAt?: string;
};

export type OutboundMessageSender = (
  item: OutboundQueueItem,
) => Promise<WebChatMessage>;

export type OutboundFlushHandlers = {
  onSent?: (item: OutboundQueueItem, message: WebChatMessage) => void;
  onFailed?: (item: OutboundQueueItem, error: unknown) => void;
};

export type OutboundFlushResult = {
  sent: WebChatMessage[];
  remaining: OutboundQueueItem[];
  failure: { item: OutboundQueueItem; error: unknown } | null;
};

export type OutboundQueue = {
  items: () => OutboundQueueItem[];
  size: () => number;
  isEmpty: () => boolean;
  isFlushing: () => boolean;
  has: (idempotencyKey: string) => boolean;
  enqueue: (input: OutboundEnqueueInput) => OutboundQueueItem;
  remove: (idempotencyKey: string) => void;
  clear: () => void;
  flush: (
    send: OutboundMessageSender,
    handlers?: OutboundFlushHandlers,
  ) => Promise<OutboundFlushResult>;
};

export type CreateOutboundQueueOptions = {
  conversationId: string;
  storage?: OutboundQueueStorage | null;
  storagePrefix?: string;
};

export function createOutboundQueue({
  conversationId,
  storage = getBrowserSessionStorage(),
  storagePrefix = DEFAULT_OUTBOUND_QUEUE_STORAGE_PREFIX,
}: CreateOutboundQueueOptions): OutboundQueue {
  const storageKey = `${storagePrefix}.${conversationId}`;
  let items = loadOutboundQueue(storage, storageKey);
  let flushing = false;

  function persist() {
    saveOutboundQueue(storage, storageKey, items);
  }

  return {
    items() {
      return [...items];
    },
    size() {
      return items.length;
    },
    isEmpty() {
      return items.length === 0;
    },
    isFlushing() {
      return flushing;
    },
    has(idempotencyKey) {
      return items.some((item) => item.idempotencyKey === idempotencyKey);
    },
    enqueue(input) {
      const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey();
      const existing = items.find(
        (item) => item.idempotencyKey === idempotencyKey,
      );
      if (existing) {
        return existing;
      }

      const item: OutboundQueueItem = {
        idempotencyKey,
        conversationId: input.conversationId,
        endpointId: input.endpointId,
        organizationId: input.organizationId,
        visitorSessionId: input.visitorSessionId,
        text: input.text,
        createdAt: input.createdAt ?? new Date().toISOString(),
        attempts: 0,
      };
      items = [...items, item];
      persist();
      return item;
    },
    remove(idempotencyKey) {
      const nextItems = items.filter(
        (item) => item.idempotencyKey !== idempotencyKey,
      );
      if (nextItems.length !== items.length) {
        items = nextItems;
        persist();
      }
    },
    clear() {
      if (items.length === 0) {
        return;
      }
      items = [];
      persist();
    },
    async flush(send, handlers = {}) {
      const sent: WebChatMessage[] = [];

      if (flushing) {
        return { sent, remaining: [...items], failure: null };
      }

      flushing = true;
      let failure: OutboundFlushResult["failure"] = null;

      try {
        // Снимок в порядке FIFO; отправляем последовательно, чтобы не нарушить
        // порядок и не допустить конкурентных дублей одного ключа.
        const snapshot = [...items];
        for (const item of snapshot) {
          if (!items.some((queued) => queued.idempotencyKey === item.idempotencyKey)) {
            continue;
          }

          const attemptItem: OutboundQueueItem = {
            ...item,
            attempts: item.attempts + 1,
          };
          items = items.map((queued) =>
            queued.idempotencyKey === item.idempotencyKey ? attemptItem : queued,
          );
          persist();

          try {
            const message = await send(attemptItem);
            items = items.filter(
              (queued) => queued.idempotencyKey !== item.idempotencyKey,
            );
            persist();
            sent.push(message);
            handlers.onSent?.(attemptItem, message);
          } catch (error) {
            failure = { item: attemptItem, error };
            handlers.onFailed?.(attemptItem, error);
            // Разрыв соединения: прекращаем цикл, сохраняя порядок оставшихся
            // реплик для переотправки после восстановления.
            break;
          }
        }
      } finally {
        flushing = false;
      }

      return { sent, remaining: [...items], failure };
    },
  };
}

export function loadOutboundQueue(
  storage: OutboundQueueStorage | null,
  storageKey: string,
): OutboundQueueItem[] {
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(normalizeStoredItem)
      .filter((item): item is OutboundQueueItem => item !== null);
  } catch {
    return [];
  }
}

export function saveOutboundQueue(
  storage: OutboundQueueStorage | null,
  storageKey: string,
  items: OutboundQueueItem[],
) {
  if (!storage) {
    return;
  }

  try {
    if (items.length === 0) {
      storage.removeItem(storageKey);
      return;
    }

    storage.setItem(storageKey, JSON.stringify(items));
  } catch {
    // Встраиваемый виджет обязан продолжать работу, даже если хост-страница
    // блокирует storage: очередь тогда живёт только в памяти вкладки.
  }
}

function normalizeStoredItem(value: unknown): OutboundQueueItem | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const idempotencyKey = getString(record.idempotencyKey);
  const conversationId = getString(record.conversationId);
  const endpointId = getString(record.endpointId);
  const organizationId = getString(record.organizationId);
  const visitorSessionId = getString(record.visitorSessionId);
  const text = getString(record.text);

  if (
    !idempotencyKey ||
    !conversationId ||
    !endpointId ||
    !organizationId ||
    !visitorSessionId ||
    text === undefined
  ) {
    return null;
  }

  return {
    idempotencyKey,
    conversationId,
    endpointId,
    organizationId,
    visitorSessionId,
    text,
    createdAt: getString(record.createdAt) ?? new Date(0).toISOString(),
    attempts:
      typeof record.attempts === "number" && Number.isFinite(record.attempts)
        ? record.attempts
        : 0,
  };
}

function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  return `web-chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getBrowserSessionStorage(): OutboundQueueStorage | null {
  try {
    return globalThis.window?.sessionStorage ?? null;
  } catch {
    return null;
  }
}
