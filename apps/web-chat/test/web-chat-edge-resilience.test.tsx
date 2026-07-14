import { http, HttpResponse } from "msw";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWebChatWidget } from "../src/bootstrap";
import { resetMockMessages } from "../src/mocks/handlers";
import { server } from "../src/mocks/server";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ENDPOINT_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../src/platform/apiClient";
import type {
  C7WebSocketEvent,
  WebChatMessage,
  WebChatWebSocketLike,
} from "../src/types";

// Интеграционный сценарий CP-7 «Потеря соединения» (ТЗ §5.5, §7.9, §7.10):
// виджет РФ идёт через Edge, при разрыве складывает реплики в буфер и
// переотправляет их после восстановления — без дублей и с сохранением порядка.
describe("Bridge Web Chat — устойчивость через Edge (CP-7)", () => {
  beforeEach(() => {
    resetMockMessages();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  it("ретраит инициализацию сессии при транзитивном сбое (502 обрыв туннеля Edge→App) и всё равно открывает чат", async () => {
    let sessionCalls = 0;
    // Первый POST /web-chat/sessions падает 502 (как при кратковременном разрыве
    // VPN-туннеля Edge→App), последующие — проходят в дефолтный mock (201).
    server.use(
      http.post("*/api/v1/web-chat/sessions", () => {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return HttpResponse.json({ code: "BAD_GATEWAY" }, { status: 502 });
        }
        return undefined;
      }),
    );

    const mountPoint = createMountPoint();
    await renderWebChatWidget(mountPoint, {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
    });

    // Несмотря на первый 502, ретрай инициализации подтянул историю — лента
    // загрузилась (пустой диалог), ошибка открытия посетителю не показана.
    expect(
      await within(mountPoint).findByText("Пока нет сообщений", undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(sessionCalls).toBeGreaterThanOrEqual(2);
  });

  it("переотправляет реплику после разрыва без дублей и подтягивает ответ менеджера", async () => {
    const user = userEvent.setup();
    const sockets: FakeWebSocket[] = [];
    const mountPoint = createMountPoint();

    await renderWebChatWidget(mountPoint, {
      apiBaseUrl: "http://localhost/api/v1",
      edgeBaseUrl: "http://edge.rf.local/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      realtimeReconnectDelayMs: 1,
      outboundQueueStorage: null,
      webSocketFactory: createWebSocketFactory(sockets),
    });

    await within(mountPoint).findByLabelText("Сообщение");
    // Трафик виджета маршрутизируется прозрачно через Edge (§18.7).
    expect(within(mountPoint).getByText(/через Edge/)).toBeInTheDocument();

    await act(async () => {
      sockets[0]?.open();
    });

    // Разрыв канала до Edge: POST /web-chat/messages начинает падать.
    server.use(
      http.post("*/api/v1/web-chat/messages", () => HttpResponse.error()),
    );

    await user.type(await screen.findByLabelText("Сообщение"), "Реплика в офлайне");
    await user.click(screen.getByRole("button", { name: /Отправить/ }));

    // Реплика не потеряна: осталась в ленте и помечена ошибкой отправки.
    expect(await screen.findByText("Реплика в офлайне")).toBeInTheDocument();
    expect(await screen.findByText("ошибка")).toBeInTheDocument();

    // Канал через Edge восстановлен — переподключаемся и переотправляем буфер.
    server.resetHandlers();
    await act(async () => {
      sockets[0]?.close();
      await wait(5);
    });
    await act(async () => {
      sockets[1]?.open();
      await wait(5);
    });

    // Дедупликация по idempotency_key: ровно одна реплика посетителя.
    expect(await screen.findByText("доставлено")).toBeInTheDocument();
    expect(screen.getAllByText("Реплика в офлайне")).toHaveLength(1);
    expect(screen.queryByText("ошибка")).not.toBeInTheDocument();

    // Демо-автоответ мока (WG-12) подтянут докруткой ленты после переотправки.
    const DEMO_REPLY =
      "Демо-режим (MSW): сообщение получено. Это автоответ мока, а не реальный менеджер.";
    expect(await screen.findByText(DEMO_REPLY)).toBeInTheDocument();

    const texts = messageTexts(mountPoint);
    expect(texts.indexOf("Реплика в офлайне")).toBeLessThan(texts.indexOf(DEMO_REPLY));
  });

  it("сохраняет порядок нескольких реплик после переподключения", async () => {
    const user = userEvent.setup();
    const sockets: FakeWebSocket[] = [];
    const mountPoint = createMountPoint();

    await renderWebChatWidget(mountPoint, {
      apiBaseUrl: "http://localhost/api/v1",
      edgeBaseUrl: "http://edge.rf.local/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      realtimeReconnectDelayMs: 1,
      outboundQueueStorage: null,
      webSocketFactory: createWebSocketFactory(sockets),
    });

    const input = await within(mountPoint).findByLabelText("Сообщение");
    await act(async () => {
      sockets[0]?.open();
    });

    server.use(
      http.post("*/api/v1/web-chat/messages", () => HttpResponse.error()),
    );

    await user.type(input, "Первое сообщение");
    await user.click(screen.getByRole("button", { name: /Отправить/ }));
    await user.type(input, "Второе сообщение");
    await user.click(screen.getByRole("button", { name: /Отправить/ }));

    expect(await screen.findByText("Первое сообщение")).toBeInTheDocument();
    expect(await screen.findByText("Второе сообщение")).toBeInTheDocument();

    server.resetHandlers();
    await act(async () => {
      sockets[0]?.close();
      await wait(5);
    });
    await act(async () => {
      sockets[1]?.open();
      await wait(10);
    });

    await screen.findAllByText("доставлено");
    expect(screen.queryByText("ошибка")).not.toBeInTheDocument();
    expect(screen.getAllByText("Первое сообщение")).toHaveLength(1);
    expect(screen.getAllByText("Второе сообщение")).toHaveLength(1);

    // Порядок в рамках Conversation сохранён: FIFO переотправка (§7.10).
    const texts = messageTexts(mountPoint);
    expect(texts.indexOf("Первое сообщение")).toBeLessThan(
      texts.indexOf("Второе сообщение"),
    );
  });

  it("догоняет первый realtime gap относительно уже загруженной истории", async () => {
    const sockets: FakeWebSocket[] = [];
    const mountPoint = createMountPoint();
    const first = createMessage("edge-message-1", 1, "История 1");
    const second = createMessage("edge-message-2", 2, "История 2");
    const missed = createMessage("edge-message-3", 3, "Буфер Edge 3", "manager");
    const live = createMessage("edge-message-4", 4, "Буфер Edge 4", "manager");
    resetMockMessages([first, second]);

    await renderWebChatWidget(mountPoint, {
      apiBaseUrl: "http://localhost/api/v1",
      edgeBaseUrl: "http://edge.rf.local/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      outboundQueueStorage: null,
      webSocketFactory: createWebSocketFactory(sockets),
    });

    expect(await screen.findByText("История 1")).toBeInTheDocument();
    expect(await screen.findByText("История 2")).toBeInTheDocument();

    // Пока виджет держал историю до sequence=2, Edge восстановил буфер 3..4.
    resetMockMessages([first, second, missed, live]);
    await act(async () => {
      sockets[0]?.open();
      sockets[0]?.emit(createC7MessageCreatedEvent(live));
      await wait(10);
    });

    expect(await screen.findByText("Буфер Edge 3")).toBeInTheDocument();
    expect(await screen.findByText("Буфер Edge 4")).toBeInTheDocument();
    expect(screen.getAllByText("Буфер Edge 4")).toHaveLength(1);
    expect(messageTexts(mountPoint)).toEqual([
      "История 1",
      "История 2",
      "Буфер Edge 3",
      "Буфер Edge 4",
    ]);
  });
});

function createWebSocketFactory(sockets: FakeWebSocket[]) {
  return (url: string): WebChatWebSocketLike => {
    const socket = new FakeWebSocket(url);
    sockets.push(socket);
    return socket;
  };
}

function createMountPoint() {
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  return mountPoint;
}

function messageTexts(mountPoint: HTMLElement): string[] {
  return Array.from(
    mountPoint.querySelectorAll(".bridge-chat-message-text"),
  ).map((element) => element.textContent ?? "");
}

class FakeWebSocket implements WebChatWebSocketLike {
  onclose: null | ((event: unknown) => void) = null;
  onerror: null | ((event: unknown) => void) = null;
  onmessage: null | ((event: { data: unknown }) => void) = null;
  onopen: null | ((event: unknown) => void) = null;

  constructor(readonly url: string) {}

  close() {
    this.onclose?.(undefined);
  }

  open() {
    this.onopen?.(undefined);
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send() {}
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createMessage(
  id: string,
  sequenceNumber: number,
  text: string,
  authorType: WebChatMessage["author"]["type"] = "visitor",
): WebChatMessage {
  return {
    id,
    conversationId: DEFAULT_CONVERSATION_ID,
    endpointId: DEFAULT_ENDPOINT_ID,
    organizationId: DEFAULT_ORGANIZATION_ID,
    channel: "web_chat",
    author: {
      type: authorType,
      displayName: authorType === "manager" ? "Менеджер" : "Посетитель",
    },
    body: {
      type: "text",
      text,
    },
    createdAt: `2026-07-04T12:0${sequenceNumber}:00.000Z`,
    sequenceNumber,
    status: authorType === "visitor" ? "delivered" : "sent",
  };
}

function createC7MessageCreatedEvent(message: WebChatMessage): C7WebSocketEvent {
  return {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "message.created",
    event_id: `edge-event-${message.sequenceNumber}`,
    organization_id: message.organizationId,
    sequence_number: message.sequenceNumber ?? 0,
    occurred_at: message.createdAt,
    payload: {
      message,
    },
  };
}
