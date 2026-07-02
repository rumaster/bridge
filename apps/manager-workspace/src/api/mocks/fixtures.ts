import type {
  C7Event,
  ClientProfile,
  Conversation,
  ManagerSession,
  Message,
  NotificationItem
} from "../client/types";

export const mockSession: ManagerSession = {
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
  expiresAt: "2026-07-02T18:00:00.000Z"
};

export const mockConversations: Conversation[] = [
  {
    id: "conv-1",
    clientId: "client-1",
    status: "open",
    channel: "web_chat",
    lastMessageAt: "2026-07-02T16:10:00.000Z",
    lastMessagePreview: "Хочу уточнить статус заказа",
    unreadCount: 2
  },
  {
    id: "conv-2",
    clientId: "client-2",
    status: "pending",
    channel: "telegram",
    lastMessageAt: "2026-07-02T16:04:00.000Z",
    lastMessagePreview: "Когда менеджер сможет ответить?",
    unreadCount: 1
  }
];

export const mockMessages: Message[] = [
  {
    id: "msg-1",
    conversationId: "conv-1",
    channel: "web_chat",
    direction: "inbound",
    senderType: "client",
    content: "Хочу уточнить статус заказа",
    status: "received",
    createdAt: "2026-07-02T16:09:15.000Z"
  },
  {
    id: "msg-2",
    conversationId: "conv-1",
    channel: "web_chat",
    direction: "outbound",
    senderType: "manager",
    content: "Приняли обращение. На следующем этапе подключим отправку ответа.",
    status: "sent",
    createdAt: "2026-07-02T16:09:50.000Z"
  },
  {
    id: "msg-3",
    conversationId: "conv-2",
    channel: "telegram",
    direction: "inbound",
    senderType: "client",
    content: "Когда менеджер сможет ответить?",
    status: "received",
    createdAt: "2026-07-02T16:04:00.000Z"
  }
];

export const mockClients: ClientProfile[] = [
  {
    id: "client-1",
    displayName: "Анна Петрова",
    tags: ["vip", "web-chat"],
    notes: ["Предпочитает короткие ответы по статусам заказов."],
    endpoints: [
      {
        id: "endpoint-1",
        channel: "web_chat",
        externalId: "web-chat:anna",
        displayName: "Web Chat"
      }
    ]
  },
  {
    id: "client-2",
    displayName: "Илья Смирнов",
    tags: ["telegram"],
    notes: ["Ждет ответа после уточнения у склада."],
    endpoints: [
      {
        id: "endpoint-2",
        channel: "telegram",
        externalId: "telegram:ilya",
        displayName: "@ilya_demo"
      }
    ]
  }
];

export const mockNotifications: NotificationItem[] = [
  {
    id: "notif-1",
    category: "info",
    title: "Новый диалог в очереди",
    body: "Анна Петрова ожидает ответа менеджера.",
    status: "new",
    createdAt: "2026-07-02T16:10:05.000Z"
  },
  {
    id: "notif-2",
    category: "warning",
    title: "Диалог ожидает дольше SLA",
    body: "Проверьте очередь перед завершением смены.",
    status: "read",
    createdAt: "2026-07-02T15:55:00.000Z"
  }
];

export const mockC7Events: C7Event[] = [
  {
    type: "message.created",
    sequenceNumber: 1001,
    payload: {
      message: mockMessages[0]
    }
  },
  {
    type: "notification.created",
    sequenceNumber: 1002,
    payload: {
      notification: mockNotifications[0]
    }
  }
];
