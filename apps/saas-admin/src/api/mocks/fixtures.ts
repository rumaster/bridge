import type {
  AdminRole,
  AdminSession,
  C7Event,
  Channel,
  ChannelCapabilityDescriptor,
  ChannelCapabilityName,
  KnowledgeDocument,
  Organization,
  OrganizationConfiguration
} from "../client/types";

export const mockSession: AdminSession = {
  authenticated: true,
  user: {
    id: "00000000-0000-4000-8000-000000000101",
    organizationId: "org-demo",
    displayName: "Демо Администратор",
    telegramUsername: "admin_demo",
    status: "active"
  },
  organization: {
    id: "org-demo",
    slug: "demo-organization",
    name: "Демо Организация"
  },
  roles: ["administrator"],
  session: {
    id: "mock-session-m1",
    mode: "mock",
    issuedAt: "2026-07-03T09:00:00.000Z",
    expiresAt: null
  },
  implementationStage: "M1"
};

export const mockOrganization: Organization = {
  id: "org-demo",
  name: "Демо Организация",
  description: "Организация для проверки M1-входа и конфигурации админ-панели.",
  timezone: "Europe/Moscow",
  locale: "ru-RU",
  status: "active",
  updatedAt: "2026-07-02T16:10:00.000Z"
};

export const mockConfiguration: OrganizationConfiguration = {
  organizationId: "org-demo",
  defaultLanguage: "ru",
  aiAssistantEnabled: true,
  workflowAutomationEnabled: true,
  monthlyMessageLimit: 10000,
  notificationEmail: "admin@example.test",
  retentionDays: 90,
  updatedAt: "2026-07-03T09:12:00.000Z"
};

export const channelCapabilityNames: ChannelCapabilityName[] = [
  "text",
  "image",
  "file",
  "voice",
  "video",
  "buttons",
  "reactions",
  "typing_indicator",
  "read_receipt",
  "delete",
  "edit"
];

export const mockChannels: Channel[] = [
  {
    id: "channel-web-chat-main",
    organization_id: "org-demo",
    channel_type: "web_chat",
    name: "Основной Web Chat",
    status: "connected",
    credentials_ref: "secret://web-chat/org-demo/main",
    config: {
      widget_origin: "https://demo.example.test"
    },
    last_check_at: "2026-07-03T10:02:00.000Z",
    created_at: "2026-07-03T09:45:00.000Z",
    updated_at: "2026-07-03T10:02:00.000Z",
    error_log: []
  },
  {
    id: "channel-telegram-main",
    organization_id: "org-demo",
    channel_type: "telegram",
    name: "Telegram Support",
    status: "error",
    credentials_ref: "secret://telegram/org-demo/support-bot",
    config: {
      bot_username: "bridge_support_bot"
    },
    last_check_at: "2026-07-03T09:55:00.000Z",
    created_at: "2026-07-03T09:40:00.000Z",
    updated_at: "2026-07-03T09:55:00.000Z",
    error_log: [
      {
        id: "channel-error-telegram-webhook",
        code: "WEBHOOK_TIMEOUT",
        message: "Webhook не ответил за 5 секунд.",
        occurred_at: "2026-07-03T09:55:00.000Z"
      }
    ]
  }
];

export const mockKnowledgeDocuments: KnowledgeDocument[] = [
  {
    id: "kb-doc-returns",
    organization_id: "org-demo",
    title: "FAQ возвратов",
    source: "manual://returns",
    status: "indexed",
    indexed_at: "2026-07-03T09:30:00.000Z",
    created_at: "2026-07-03T09:10:00.000Z",
    updated_at: "2026-07-03T09:30:00.000Z",
    file_name: "returns.md",
    content_type: "text/markdown",
    size_bytes: 4096
  },
  {
    id: "kb-doc-delivery",
    organization_id: "org-demo",
    title: "Регламент доставки",
    source: "manual://delivery",
    status: "indexing",
    indexed_at: null,
    created_at: "2026-07-03T09:35:00.000Z",
    updated_at: "2026-07-03T09:36:00.000Z",
    file_name: "delivery.pdf",
    content_type: "application/pdf",
    size_bytes: 8192
  },
  {
    id: "kb-doc-prices",
    organization_id: "org-demo",
    title: "Прайс-лист",
    source: "manual://prices",
    status: "failed",
    indexed_at: null,
    created_at: "2026-07-03T09:15:00.000Z",
    updated_at: "2026-07-03T09:20:00.000Z",
    file_name: "prices.xlsx",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: 10240,
    error_message: "Файл содержит пустые обязательные колонки."
  }
];

export const mockC7Events: C7Event[] = [
  {
    type: "channel.status_changed",
    sequenceNumber: 1,
    payload: {
      channelId: "channel-telegram-main",
      status: "connected",
      lastCheckAt: "2026-07-03T10:14:00.000Z"
    }
  }
];

export function createMockSession(roles: AdminRole[] = ["administrator"]): AdminSession {
  return {
    ...mockSession,
    user: { ...mockSession.user },
    organization: { ...mockSession.organization },
    roles: [...roles],
    session: { ...mockSession.session }
  };
}

export function createMockCapabilityDescriptor(
  channel: Pick<Channel, "id" | "channel_type">,
  generatedAt = "2026-07-03T10:05:00.000Z"
): ChannelCapabilityDescriptor {
  const supported =
    channel.channel_type === "web_chat"
      ? new Set<ChannelCapabilityName>(["text", "image", "file", "typing_indicator", "read_receipt"])
      : new Set<ChannelCapabilityName>(["text", "image", "buttons", "read_receipt"]);

  return {
    contract: "C6.CapabilityDescriptor",
    version: "1.0.0",
    channel_type: channel.channel_type,
    channel_id: channel.id,
    adapter: {
      name: `${channel.channel_type}-adapter`,
      version: "0.0.0"
    },
    capabilities: Object.fromEntries(
      channelCapabilityNames.map((capability) => [
        capability,
        supported.has(capability)
          ? { supported: true }
          : { supported: false, notes: "Не поддерживается текущим адаптером." }
      ])
    ) as ChannelCapabilityDescriptor["capabilities"],
    generated_at: generatedAt
  };
}
