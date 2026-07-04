import { http, HttpResponse } from "msw";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWebChatWidget } from "../src/bootstrap";
import { resetMockMessages } from "../src/mocks/handlers";
import { server } from "../src/mocks/server";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../src/platform/apiClient";
import type { WebChatWebSocketLike } from "../src/types";

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

    // Разрыв канала до Edge: POST /messages начинает падать.
    server.use(
      http.post("*/api/v1/messages", () => HttpResponse.error()),
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

    // Ответ менеджера подтянут докруткой ленты после переотправки (§7.10).
    expect(
      await screen.findByText("Здравствуйте! Менеджер получил сообщение."),
    ).toBeInTheDocument();

    const texts = messageTexts(mountPoint);
    expect(texts.indexOf("Реплика в офлайне")).toBeLessThan(
      texts.indexOf("Здравствуйте! Менеджер получил сообщение."),
    );
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
      http.post("*/api/v1/messages", () => HttpResponse.error()),
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

  send() {}
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
