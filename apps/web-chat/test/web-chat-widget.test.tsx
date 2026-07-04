import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWebChatWidget } from "../src/bootstrap";
import { resetMockMessages } from "../src/mocks/handlers";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ENDPOINT_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../src/platform/apiClient";
import type { WebChatMessage } from "../src/types";

describe("Bridge Web Chat widget", () => {
  it("монтирует виджет в переданную точку", async () => {
    const mountPoint = document.createElement("div");
    document.body.append(mountPoint);

    await renderWebChatWidget(mountPoint, {
      apiBaseUrl: "http://localhost/api/v1",
    });

    expect(
      await within(mountPoint).findByRole("log", { name: "Лента Web Chat" }),
    ).toBeInTheDocument();
  });

  it("рендерит пустую ленту для нового диалога", async () => {
    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
    });

    expect(await screen.findByText("Пока нет сообщений")).toBeInTheDocument();
  });

  it("рендерит поле ввода сообщения", async () => {
    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
    });

    expect(await screen.findByLabelText("Сообщение")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Отправить" }),
    ).toBeDisabled();
  });

  it("сохраняет M5 accessibility-инварианты ленты, статуса и клавиатурного фокуса", async () => {
    const user = userEvent.setup();
    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
    });

    const thread = await screen.findByRole("log", { name: "Лента Web Chat" });
    expect(thread).toHaveAttribute("aria-live", "polite");
    expect(thread).toHaveAttribute("aria-relevant", "additions text");
    expect(thread).toHaveAttribute("aria-atomic", "false");

    const connectionStatus = screen.getByRole("status", {
      name: "Состояние соединения Web Chat",
    });
    expect(connectionStatus).toHaveTextContent("офлайн");

    const input = screen.getByRole("textbox", { name: "Сообщение" });
    expect(input).toHaveAttribute(
      "aria-describedby",
      "bridge-chat-connection-status",
    );

    await user.type(input, "Доступная отправка");
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Доступная отправка")).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("отправляет сообщение через мок C3.messages и добавляет его в ленту", async () => {
    const user = userEvent.setup();
    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
    });

    await user.type(await screen.findByLabelText("Сообщение"), "Здравствуйте");
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Здравствуйте")).toBeInTheDocument();
    expect(await screen.findByText("доставлено")).toBeInTheDocument();
    expect(
      await screen.findByText("Здравствуйте! Менеджер получил сообщение."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Сообщение")).toHaveValue("");
  });

  it("рендерит AI-ответ в общей ленте без отдельного режима", async () => {
    resetMockMessages([
      createMessage({
        authorType: "ai",
        displayName: "Bridge AI",
        id: "62345678-1234-4234-8234-123456789abc",
        sequenceNumber: 1,
        text: "Я нашел подходящий ответ в базе знаний.",
      }),
    ]);

    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
    });

    expect(await screen.findByText("Bridge AI")).toBeInTheDocument();
    expect(
      await screen.findByText("Я нашел подходящий ответ в базе знаний."),
    ).toBeInTheDocument();
  });

  it("подгружает предыдущие страницы истории без дублей", async () => {
    const user = userEvent.setup();
    resetMockMessages([
      createMessage({
        id: "72345678-1234-4234-8234-123456789abc",
        sequenceNumber: 1,
        text: "Первое сообщение",
      }),
      createMessage({
        id: "82345678-1234-4234-8234-123456789abc",
        sequenceNumber: 2,
        text: "Второе сообщение",
      }),
      createMessage({
        authorType: "manager",
        displayName: "Менеджер",
        id: "92345678-1234-4234-8234-123456789abc",
        sequenceNumber: 3,
        text: "Третье сообщение",
      }),
    ]);

    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      historyPageSize: 2,
      organizationId: DEFAULT_ORGANIZATION_ID,
    });

    expect(await screen.findByText("Второе сообщение")).toBeInTheDocument();
    expect(await screen.findByText("Третье сообщение")).toBeInTheDocument();
    expect(screen.queryByText("Первое сообщение")).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: "Загрузить предыдущие" }),
    );

    expect(await screen.findByText("Первое сообщение")).toBeInTheDocument();
    expect(screen.getAllByText("Второе сообщение")).toHaveLength(1);
  });
});

function createMountPoint() {
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  return mountPoint;
}

function createMessage({
  authorType = "visitor",
  displayName = "Посетитель",
  id,
  sequenceNumber,
  text,
}: {
  authorType?: WebChatMessage["author"]["type"];
  displayName?: string;
  id: string;
  sequenceNumber: number;
  text: string;
}): WebChatMessage {
  return {
    id,
    conversationId: DEFAULT_CONVERSATION_ID,
    endpointId: DEFAULT_ENDPOINT_ID,
    organizationId: DEFAULT_ORGANIZATION_ID,
    channel: "web_chat",
    author: {
      type: authorType,
      displayName,
    },
    body: {
      type: "text",
      text,
    },
    createdAt: `2026-07-03T09:0${sequenceNumber}:00.000Z`,
    sequenceNumber,
    status: authorType === "visitor" ? "delivered" : "sent",
  };
}
