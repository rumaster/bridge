import { describe, expect, it, vi } from "vitest";
import {
  createOutboundQueue,
  DEFAULT_OUTBOUND_QUEUE_STORAGE_PREFIX,
  loadOutboundQueue,
  type OutboundQueueItem,
  type OutboundQueueStorage,
} from "../src/platform/outboundQueue";
import type { WebChatMessage } from "../src/types";

const CONVERSATION_ID = "conv-cp7";

describe("Bridge Web Chat outbound queue (CP-7)", () => {
  it("присваивает стабильный idempotency_key и сохраняет FIFO-порядок", () => {
    const queue = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage: createMemoryStorage(),
    });

    const first = queue.enqueue(enqueueInput("Первое"));
    const second = queue.enqueue(enqueueInput("Второе"));

    expect(first.idempotencyKey).toMatch(/.+/);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(queue.items().map((item) => item.text)).toEqual([
      "Первое",
      "Второе",
    ]);
  });

  it("не дублирует запись при повторном enqueue с тем же ключом", () => {
    const queue = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage: createMemoryStorage(),
    });

    queue.enqueue({ ...enqueueInput("Повтор"), idempotencyKey: "key-1" });
    queue.enqueue({ ...enqueueInput("Повтор"), idempotencyKey: "key-1" });

    expect(queue.size()).toBe(1);
  });

  it("переотправляет реплики последовательно и в порядке очереди", async () => {
    const queue = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage: createMemoryStorage(),
    });
    queue.enqueue(enqueueInput("A"));
    queue.enqueue(enqueueInput("B"));
    queue.enqueue(enqueueInput("C"));

    const order: string[] = [];
    const result = await queue.flush(async (item) => {
      order.push(item.text);
      return mockMessage(item);
    });

    expect(order).toEqual(["A", "B", "C"]);
    expect(result.sent.map((message) => message.body.text)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(queue.isEmpty()).toBe(true);
  });

  it("сохраняет один и тот же idempotency_key между попытками (дедупликация)", async () => {
    const queue = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage: createMemoryStorage(),
    });
    const item = queue.enqueue(enqueueInput("Идемпотентное"));

    const keys: string[] = [];
    const send = vi
      .fn<(queued: OutboundQueueItem) => Promise<WebChatMessage>>()
      .mockImplementationOnce((queued) => {
        keys.push(queued.idempotencyKey);
        return Promise.reject(new Error("edge down"));
      })
      .mockImplementationOnce((queued) => {
        keys.push(queued.idempotencyKey);
        return Promise.resolve(mockMessage(queued));
      });

    const failed = await queue.flush(send);
    expect(failed.failure).not.toBeNull();
    expect(queue.size()).toBe(1);

    const recovered = await queue.flush(send);
    expect(recovered.failure).toBeNull();
    expect(queue.isEmpty()).toBe(true);

    expect(keys).toEqual([item.idempotencyKey, item.idempotencyKey]);
  });

  it("останавливает отправку на разрыве и сохраняет порядок оставшихся реплик", async () => {
    const queue = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage: createMemoryStorage(),
    });
    queue.enqueue(enqueueInput("A"));
    queue.enqueue(enqueueInput("B"));
    queue.enqueue(enqueueInput("C"));

    const result = await queue.flush(async (item) => {
      if (item.text === "B") {
        throw new Error("edge disconnect");
      }
      return mockMessage(item);
    });

    expect(result.sent.map((message) => message.body.text)).toEqual(["A"]);
    expect(result.remaining.map((item) => item.text)).toEqual(["B", "C"]);
  });

  it("переживает перезагрузку: очередь восстанавливается из storage", async () => {
    const storage = createMemoryStorage();
    const queue = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage,
    });
    queue.enqueue(enqueueInput("Черновик"));

    const storageKey = `${DEFAULT_OUTBOUND_QUEUE_STORAGE_PREFIX}.${CONVERSATION_ID}`;
    expect(loadOutboundQueue(storage, storageKey)).toHaveLength(1);

    const restored = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage,
    });
    expect(restored.items().map((item) => item.text)).toEqual(["Черновик"]);

    await restored.flush(async (item) => mockMessage(item));
    expect(loadOutboundQueue(storage, storageKey)).toHaveLength(0);
  });

  it("не запускает конкурентный flush (защита от двойной отправки)", async () => {
    const queue = createOutboundQueue({
      conversationId: CONVERSATION_ID,
      storage: createMemoryStorage(),
    });
    queue.enqueue(enqueueInput("Единственное"));

    let sendCount = 0;
    const send = async (item: OutboundQueueItem) => {
      sendCount += 1;
      await wait(5);
      return mockMessage(item);
    };

    const [first, second] = await Promise.all([
      queue.flush(send),
      queue.flush(send),
    ]);

    expect(sendCount).toBe(1);
    expect(first.sent.length + second.sent.length).toBe(1);
  });
});

function enqueueInput(text: string) {
  return {
    conversationId: CONVERSATION_ID,
    endpointId: "endpoint-1",
    organizationId: "org-1",
    visitorSessionId: "visitor-1",
    text,
  };
}

function mockMessage(item: OutboundQueueItem): WebChatMessage {
  return {
    id: item.idempotencyKey,
    idempotencyKey: item.idempotencyKey,
    organizationId: item.organizationId,
    conversationId: item.conversationId,
    endpointId: item.endpointId,
    channel: "web_chat",
    author: {
      type: "visitor",
      displayName: "Посетитель",
    },
    body: {
      type: "text",
      text: item.text,
    },
    createdAt: item.createdAt,
    status: "delivered",
  };
}

function createMemoryStorage(): OutboundQueueStorage {
  const store = new Map<string, string>();
  return {
    getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
