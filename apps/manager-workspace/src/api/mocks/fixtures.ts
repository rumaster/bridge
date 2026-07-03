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
    createdAt: "2026-07-02T16:09:15.000Z",
    attachments: [
      {
        id: "att-1",
        name: "order-status.png",
        contentType: "image/png",
        sizeBytes: 184320,
        url: "https://example.test/files/order-status.png"
      }
    ]
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
    status: "offline",
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
    status: "offline",
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

export const mockLiveMessage: Message = {
  id: "msg-live-1",
  conversationId: "conv-1",
  channel: "web_chat",
  direction: "inbound",
  senderType: "client",
  content: "Есть обновления по доставке заказа?",
  status: "received",
  createdAt: "2026-07-02T16:11:00.000Z"
};

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
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "typing.started",
    event_id: "c7-event-1001",
    organization_id: "org-1",
    sequence_number: 1001,
    payload: {
      conversation_id: "conv-1",
      client_id: "client-1"
    },
    occurred_at: "2026-07-02T16:10:10.000Z"
  },
  {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "message.created",
    event_id: "c7-event-1002",
    organization_id: "org-1",
    sequence_number: 1002,
    payload: {
      message: mockLiveMessage
    },
    occurred_at: "2026-07-02T16:11:00.000Z"
  },
  {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "message.status_changed",
    event_id: "c7-event-1003",
    organization_id: "org-1",
    sequence_number: 1003,
    payload: {
      message_id: "msg-2",
      conversation_id: "conv-1",
      status: "delivered"
    },
    occurred_at: "2026-07-02T16:11:05.000Z"
  },
  {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "client.status_changed",
    event_id: "c7-event-1004",
    organization_id: "org-1",
    sequence_number: 1004,
    payload: {
      client_id: "client-1",
      status: "online"
    },
    occurred_at: "2026-07-02T16:11:06.000Z"
  },
  {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "typing.stopped",
    event_id: "c7-event-1005",
    organization_id: "org-1",
    sequence_number: 1005,
    payload: {
      conversation_id: "conv-1",
      client_id: "client-1"
    },
    occurred_at: "2026-07-02T16:11:10.000Z"
  },
  {
    contract: "C7.WebSocketEvent",
    version: "1.0.0",
    event: "notification.created",
    event_id: "c7-event-1006",
    organization_id: "org-1",
    sequence_number: 1006,
    payload: {
      notification: mockNotifications[0]
    },
    occurred_at: "2026-07-02T16:11:12.000Z"
  }
];
