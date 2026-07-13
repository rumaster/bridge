import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClientProfile,
  Conversation,
  ManagerSession,
  ManagerWorkspaceApiClient,
  Message
} from "../src/api/client/types";
import type { C7RealtimeClient } from "../src/api/client/realtime";
import { createManagerWorkspaceRouter } from "../src/routing/router";
import type { ManagerWorkspaceNfrMeasurement, ManagerWorkspaceNfrSink } from "../src/shared/nfr";
import type { ManagerWorkspaceServices } from "../src/state/workspace";

describe("Manager Workspace M5 performance and acceptance", () => {
  afterEach(() => {
    globalThis.__BRIDGE_MWS_NFR__ = undefined;
  });

  it("loads the queue with one C3.conversations and one C3.clients request and records the NFR budget", async () => {
    const { services, api } = createMeasuredWorkspaceServices();
    enableNfrMeasurements();

    renderRoute("/queue", services);

    expect(await screen.findByRole("heading", { name: "Очередь диалогов" })).toBeInTheDocument();
    expect(await screen.findByText("Клиент 001")).toBeInTheDocument();

    expect(api.conversations.list).toHaveBeenCalledTimes(1);
    expect(api.clients.list).toHaveBeenCalledTimes(1);
    expect(getNfrMeasurement("conversation_list")).toMatchObject({
      budgetMs: 1000,
      withinBudget: true
    });
  });

  it("virtualizes a long dialog history and records the history NFR budget", async () => {
    const { services, api } = createMeasuredWorkspaceServices({ messageCount: 1200 });
    enableNfrMeasurements();
    const { container } = renderRoute("/dialogs/conv-1", services);

    expect(await screen.findByRole("heading", { name: "Диалог" })).toBeInTheDocument();
    expect(await screen.findByText("Сообщение 1199")).toBeInTheDocument();

    await waitFor(() => {
      expect(container.querySelectorAll(".message-bubble").length).toBeLessThanOrEqual(90);
    });

    expect(screen.queryByText("Сообщение 0000")).not.toBeInTheDocument();
    expect(api.conversations.get).toHaveBeenCalledTimes(1);
    expect(api.conversations.listMessages).toHaveBeenCalledTimes(1);
    expect(api.clients.get).toHaveBeenCalledTimes(1);
    expect(getNfrMeasurement("message_history")).toMatchObject({
      budgetMs: 2000,
      withinBudget: true
    });
  });

  it("sends a manager reply once and records the send NFR budget", async () => {
    const { services, api } = createMeasuredWorkspaceServices();
    const user = userEvent.setup();
    enableNfrMeasurements();

    renderRoute("/dialogs/conv-1", services);

    expect(await screen.findByRole("heading", { name: "Диалог" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Ответ менеджера"), "M5 ответ в рамках NFR");
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("M5 ответ в рамках NFR")).toBeInTheDocument();
    expect(api.messages.create).toHaveBeenCalledTimes(1);
    expect(getNfrMeasurement("send_message")).toMatchObject({
      budgetMs: 1000,
      withinBudget: true
    });
  });
});

function renderRoute(path: string, services: ManagerWorkspaceServices) {
  const router = createManagerWorkspaceRouter({
    initialEntries: [path],
    services
  });

  return render(<RouterProvider router={router} />);
}

function enableNfrMeasurements() {
  const sink: ManagerWorkspaceNfrSink = {
    enabled: true,
    measurements: []
  };

  globalThis.__BRIDGE_MWS_NFR__ = sink;
}

function getNfrMeasurement(operation: ManagerWorkspaceNfrMeasurement["operation"]) {
  const measurement = globalThis.__BRIDGE_MWS_NFR__?.measurements?.find((item) => item.operation === operation);

  expect(measurement, `measurement ${operation}`).toBeTruthy();

  return measurement;
}

function createMeasuredWorkspaceServices(options: { messageCount?: number } = {}) {
  const messageCount = options.messageCount ?? 12;
  const clients = createClients(80);
  const conversations = createConversations(clients);
  const messages = createMessages(messageCount);
  const sentMessages = new Map<string, Message>();
  const session: ManagerSession = {
    token: "mock-manager-session",
    user: {
      id: "manager-1",
      displayName: "Демо Менеджер",
      role: "manager",
      telegramUsername: "manager_demo"
    },
    organization: {
      id: "org-1",
      name: "Bridge Demo"
    },
    expiresAt: "2026-07-04T18:00:00.000Z"
  };

  const api: ManagerWorkspaceApiClient = {
    auth: {
      getSession: vi.fn(async () => session),
      startTelegramLogin: vi.fn(),
      verifyTelegramLogin: vi.fn(),
      logout: vi.fn()
    },
    conversations: {
      list: vi.fn(async () => conversations.map((conversation) => ({ ...conversation }))),
      get: vi.fn(async (conversationId: string) => {
        const conversation = conversations.find((item) => item.id === conversationId);

        if (!conversation) {
          throw new Error("Conversation not found");
        }

        return { ...conversation };
      }),
      listMessages: vi.fn(async (conversationId: string) =>
        messages.filter((message) => message.conversationId === conversationId).map((message) => ({ ...message }))
      )
    },
    messages: {
      create: vi.fn(async (request) => {
        const existingMessage = sentMessages.get(request.idempotencyKey);

        if (existingMessage) {
          return { ...existingMessage };
        }

        const message: Message = {
          id: `sent-${sentMessages.size + 1}`,
          conversationId: request.conversationId,
          channel: "web_chat",
          direction: "outbound",
          senderType: "manager",
          content: request.content,
          status: "sent",
          createdAt: "2026-07-04T12:30:00.000Z"
        };

        sentMessages.set(request.idempotencyKey, message);
        return { ...message };
      }),
      get: vi.fn()
    },
    attachments: {
      download: vi.fn(async () => new Blob(["mock"])),
      upload: vi.fn(async (file: File) => ({
        storageRef: `edge-attach://mock-org/${file.name}`,
        name: file.name,
        contentType: file.type || null,
        sizeBytes: file.size
      }))
    },
    clients: {
      list: vi.fn(async () => clients.map((client) => copyClient(client))),
      get: vi.fn(async (clientId: string) => {
        const client = clients.find((item) => item.id === clientId);

        if (!client) {
          throw new Error("Client not found");
        }

        return copyClient(client);
      })
    },
    notifications: {
      list: vi.fn(async () => []),
      markRead: vi.fn()
    },
    ai: {
      suggest: vi.fn(async () => {
        throw new Error("AI unavailable");
      })
    }
  };

  return {
    api,
    services: {
      api,
      realtime: createNoopRealtimeClient()
    }
  };
}

function createNoopRealtimeClient(): C7RealtimeClient {
  return {
    connect(_onEvent, onStatus) {
      onStatus?.("connected");

      return {
        close() {
          onStatus?.("offline");
        }
      };
    },
    async collectInitialEvents() {
      return [];
    }
  };
}

function createClients(count: number): ClientProfile[] {
  return Array.from({ length: count }, (_, index) => {
    const idNumber = String(index + 1).padStart(3, "0");

    return {
      id: `client-${index + 1}`,
      displayName: `Клиент ${idNumber}`,
      status: index % 2 === 0 ? "online" : "offline",
      tags: ["m5", index % 2 === 0 ? "priority" : "regular"],
      notes: [`Тестовая заметка ${idNumber}`],
      endpoints: [
        {
          id: `endpoint-${index + 1}`,
          channel: "web_chat",
          externalId: `web-chat:client-${idNumber}`,
          displayName: "Web Chat"
        }
      ]
    };
  });
}

function createConversations(clients: ClientProfile[]): Conversation[] {
  return clients.map((client, index) => ({
    id: `conv-${index + 1}`,
    clientId: client.id,
    status: index % 3 === 0 ? "open" : index % 3 === 1 ? "pending" : "closed",
    channel: "web_chat",
    lastMessageAt: `2026-07-04T12:${String(59 - (index % 50)).padStart(2, "0")}:00.000Z`,
    lastMessagePreview: `Последнее сообщение ${index + 1}`,
    unreadCount: index % 4
  }));
}

function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    conversationId: "conv-1",
    channel: "web_chat",
    direction: index % 2 === 0 ? "inbound" : "outbound",
    senderType: index % 2 === 0 ? "client" : "manager",
    content: `Сообщение ${String(index).padStart(4, "0")}`,
    status: index % 2 === 0 ? "received" : "delivered",
    createdAt: `2026-07-04T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`
  }));
}

function copyClient(client: ClientProfile): ClientProfile {
  return {
    ...client,
    tags: [...client.tags],
    notes: [...client.notes],
    endpoints: client.endpoints.map((endpoint) => ({ ...endpoint }))
  };
}
